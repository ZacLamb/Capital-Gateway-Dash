require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { GHL } = require('./lib/ghl');
const { computeDeal, computedWriteback, round2 } = require('./lib/calc');

const PORT = process.env.PORT || 3000;
const DEMO = String(process.env.DEMO_MODE || '').toLowerCase() === 'true' || !process.env.GHL_TOKEN;
const LOCATION_ID = process.env.GHL_LOCATION_ID || 'WUqaLeDuJ5H8kocqpip7';
const CACHE_MS = Number(process.env.CACHE_SECONDS || 120) * 1000;
const AUTO_WRITEBACK = String(process.env.AUTO_WRITEBACK || 'true').toLowerCase() === 'true';
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// ---- Logins -------------------------------------------------------------
// OWNER_PASSWORD  → owner / manager view (everything)
// REP_PASSWORDS   → JSON: {"Aaron Meckler":"pw1","Steve Gordon":"pw2"} — names must match the GHL dropdown
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || process.env.DASHBOARD_PASSWORD || (DEMO ? 'owner' : null);
let REP_PASSWORDS = {};
try { REP_PASSWORDS = JSON.parse(process.env.REP_PASSWORDS || '{}'); } catch { console.error('REP_PASSWORDS is not valid JSON'); }
if (DEMO && !Object.keys(REP_PASSWORDS).length) {
  REP_PASSWORDS = { 'Aaron Meckler': 'aaron', 'Daniel Talkins': 'daniel', 'John Elfassi': 'john', 'Steve Gordon': 'steve' };
}
if (!OWNER_PASSWORD) console.warn('OWNER_PASSWORD not set — owner login disabled');

const sign = (payload) => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return body + '.' + crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
};
const verify = (token) => {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const want = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.exp > Date.now() ? p : null; } catch { return null; }
};
const safeEq = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

const ghl = DEMO ? null : new GHL({ token: process.env.GHL_TOKEN, locationId: LOCATION_ID });
const demoDeals = DEMO ? JSON.parse(JSON.stringify(require('./lib/demo'))) : null;

const app = express();
app.set('trust proxy', 1);
// Allow embedding inside GoHighLevel only
app.use((req, res, next) => { res.set('Content-Security-Policy', "frame-ancestors 'self' https://*.gohighlevel.com https://*.leadconnectorhq.com https://*.msgsndr.com " + (process.env.FRAME_ANCESTORS || '')); next(); });
app.use(express.json());

const readCookie = (req, name) => {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
};
app.use((req, res, next) => { req.user = verify(readCookie(req, 'cg_session')); next(); });

const needUser = (req, res, next) => req.user ? next() : res.status(401).json({ error: 'Login required' });
const needOwner = (req, res, next) => req.user?.role === 'owner' ? next() : res.status(403).json({ error: 'Owner access only' });

app.post('/api/login', (req, res) => {
  const pw = String(req.body.password || '');
  let user = null;
  if (OWNER_PASSWORD && safeEq(pw, OWNER_PASSWORD)) user = { role: 'owner', name: 'Owner' };
  else {
    const hit = Object.entries(REP_PASSWORDS).find(([, p]) => p && safeEq(pw, p));
    if (hit) user = { role: 'rep', name: hit[0] };
  }
  if (!user) return res.status(401).json({ error: 'Wrong password' });
  const token = sign({ ...user, exp: Date.now() + 30 * 86400000 });
  // SameSite=None so the login also works when the dashboard is opened inside GHL (iframe)
  res.set('Set-Cookie', `cg_session=${token}; Path=/; HttpOnly; Max-Age=${30 * 86400}; ${req.secure ? 'SameSite=None; Secure; Partitioned' : 'SameSite=Lax'}`);
  res.json({ ...user, demo: DEMO });
});
app.post('/api/logout', (req, res) => {
  res.set('Set-Cookie', `cg_session=; Path=/; HttpOnly; Max-Age=0; ${req.secure ? 'SameSite=None; Secure; Partitioned' : 'SameSite=Lax'}`);
  res.json({ ok: true });
});
app.get('/api/me', (req, res) => res.json(req.user ? { ...req.user, demo: DEMO, reps: req.user.role === 'owner' ? Object.keys(REP_PASSWORDS) : undefined } : null));

app.use(express.static(path.join(__dirname, 'public')));

// ---- Data ---------------------------------------------------------------
let cache = { at: 0, data: null };

async function loadRaw() {
  if (DEMO) return demoDeals.map((d) => ({ ...d, fields: { ...d.fields } }));
  if (!ghl.fieldMap) await ghl.loadFields();
  const [opps, pipelines] = await Promise.all([ghl.allOpportunities(), ghl.listPipelines()]);
  const stageName = {}, pipeName = {};
  for (const p of pipelines) { pipeName[p.id] = p.name; for (const s of p.stages || []) stageName[s.id] = s.name; }
  return opps
    .map((o) => ({
      id: o.id,
      name: o.name || o.contact?.businessName || o.contact?.name || 'Untitled',
      stage: stageName[o.pipelineStageId] || '',
      pipeline: pipeName[o.pipelineId] || '',
      fields: ghl.flatten(o),
    }))
    .filter((o) => o.fields.funded_amount !== undefined && o.fields.funded_amount !== null && o.fields.funded_amount !== '');
}

async function build(force = false) {
  if (!force && cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;
  const raw = await loadRaw();
  const deals = raw.map((r) => ({ ...r, calc: computeDeal(r.fields) }));

  if (!DEMO && AUTO_WRITEBACK) {
    for (const d of deals) {
      const wb = computedWriteback(d.fields, d.calc);
      if (Object.keys(wb).length) {
        try { await ghl.updateFields(d.id, wb); Object.assign(d.fields, wb); }
        catch (e) { console.error('writeback failed', d.id, e.message); }
      }
    }
  }
  deals.sort((a, b) => String(b.calc.fundedDate).localeCompare(String(a.calc.fundedDate)));
  cache = { at: Date.now(), data: { generatedAt: new Date().toISOString(), deals } };
  return cache.data;
}

const sum = (arr, fn) => round2(arr.reduce((s, d) => s + (fn(d) || 0), 0));

function ownerView(data) {
  const deals = data.deals;
  const totals = {
    deals: deals.length,
    active: deals.filter((d) => !['Paid Off', 'Default'].includes(d.calc.status)).length,
    funded: sum(deals, (d) => d.calc.funded),
    rtr: sum(deals, (d) => d.calc.rtr),
    collected: sum(deals, (d) => d.calc.collected),
    outstanding: sum(deals, (d) => (d.calc.status === 'Paid Off' ? 0 : d.calc.balance)),
    atRisk: sum(deals.filter((d) => ['Slow Pay', 'Default'].includes(d.calc.status)), (d) => d.calc.balance),
    commission: sum(deals, (d) => d.calc.commission),
    repPayouts: sum(deals, (d) => d.calc.repTotal),
    house: sum(deals, (d) => d.calc.house),
    missed: deals.reduce((s, d) => s + d.calc.missed, 0),
    renewals: deals.filter((d) => d.calc.renewalEligible && d.calc.status !== 'Paid Off').length,
  };
  const reps = {};
  const credit = (agent, role, amount, d) => {
    if (!agent) return;
    const r = (reps[agent] = reps[agent] || { agent, opened: 0, closed: 0, earned: 0, funded: 0, deals: [] });
    role === 'Opener' ? r.opened++ : r.closed++;
    r.earned = round2(r.earned + (amount || 0));
    r.funded = round2(r.funded + (d.calc.funded || 0));
    r.deals.push({ id: d.id, name: d.name, role, amount });
  };
  for (const d of deals) {
    if (d.calc.opener) credit(d.calc.opener.agent, 'Opener', d.calc.opener.amount, d);
    for (const c of d.calc.closers) credit(c.agent, `Closer ${c.slot}`, c.amount, d);
  }
  return { view: 'owner', generatedAt: data.generatedAt, demo: DEMO, totals, reps: Object.values(reps).sort((a, b) => b.earned - a.earned), deals };
}

// Rep sees only deals they're on, and only their own cut — no house, no other reps' pay.
function repView(data, agent) {
  const mine = [];
  for (const d of data.deals) {
    const c = d.calc;
    const roles = [];
    if (c.opener?.agent === agent) roles.push({ role: 'Opener', pct: c.opener.pct, amount: c.opener.amount });
    for (const x of c.closers) if (x.agent === agent) roles.push({ role: `Closer ${x.slot}`, pct: x.pct, amount: x.amount });
    if (!roles.length) continue;
    const { opener, closers, house, repTotal, splitPct, commission, commissionPct, ...keep } = c;
    mine.push({ id: d.id, name: d.name, stage: d.stage, pipeline: d.pipeline, calc: { ...keep, team: [opener?.agent, ...closers.map((x) => x.agent)].filter((n) => n && n !== agent) }, me: { roles, earned: round2(roles.reduce((s, r) => s + (r.amount || 0), 0)) } });
  }
  const totals = {
    deals: mine.length,
    earned: sum(mine, (d) => d.me.earned),
    funded: sum(mine, (d) => d.calc.funded),
    opened: mine.filter((d) => d.me.roles.some((r) => r.role === 'Opener')).length,
    closed: mine.filter((d) => d.me.roles.some((r) => r.role !== 'Opener')).length,
    renewals: mine.filter((d) => d.calc.renewalEligible && d.calc.status !== 'Paid Off').length,
    atRisk: mine.filter((d) => ['Slow Pay', 'Default'].includes(d.calc.status)).length,
  };
  return { view: 'rep', agent, generatedAt: data.generatedAt, demo: DEMO, totals, deals: mine };
}

// Team leaderboard — everyone can see it. Pay $ only for owner, or for all if TEAM_SHOW_PAY=true.
const TEAM_SHOW_PAY = String(process.env.TEAM_SHOW_PAY || '').toLowerCase() === 'true';
function inPeriod(dateStr, period, now = new Date()) {
  if (period === 'all' || !dateStr) return period === 'all';
  const d = new Date(dateStr + 'T12:00:00Z');
  if (period === 'month') return d.getUTCFullYear() === now.getUTCFullYear() && d.getUTCMonth() === now.getUTCMonth();
  if (period === 'quarter') return d.getUTCFullYear() === now.getUTCFullYear() && Math.floor(d.getUTCMonth() / 3) === Math.floor(now.getUTCMonth() / 3);
  return true;
}
function teamView(data, period, showPay, me) {
  const deals = data.deals.filter((d) => inPeriod(d.calc.fundedDate, period));
  const reps = {};
  const add = (agent, role, d, amount) => {
    if (!agent) return;
    const r = (reps[agent] = reps[agent] || { agent, deals: 0, opened: 0, closed: 0, funded: 0, earned: 0, ids: new Set() });
    role === 'Opener' ? r.opened++ : r.closed++;
    if (!r.ids.has(d.id)) { r.ids.add(d.id); r.deals++; r.funded = round2(r.funded + (d.calc.funded || 0)); }
    r.earned = round2(r.earned + (amount || 0));
  };
  for (const d of deals) {
    if (d.calc.opener) add(d.calc.opener.agent, 'Opener', d, d.calc.opener.amount);
    for (const c of d.calc.closers) add(c.agent, 'Closer', d, c.amount);
  }
  const board = Object.values(reps)
    .map(({ ids, earned, ...r }) => ({ ...r, ...(showPay || r.agent === me ? { earned } : {}) }))
    .sort((a, b) => b.funded - a.funded || b.deals - a.deals);
  const feed = deals.slice(0, 8).map((d) => ({
    name: d.name, funded: d.calc.funded, date: d.calc.fundedDate,
    reps: [d.calc.opener?.agent, ...d.calc.closers.map((c) => c.agent)].filter(Boolean),
  }));
  return {
    view: 'team', period, showPay, me, generatedAt: data.generatedAt, demo: DEMO,
    totals: { deals: deals.length, funded: sum(deals, (d) => d.calc.funded), avg: deals.length ? round2(sum(deals, (d) => d.calc.funded) / deals.length) : 0 },
    board, feed,
  };
}
// Public: the Team board needs no login. Pay $ only shows for owners (or everyone if TEAM_SHOW_PAY=true).
const TEAM_KEY = process.env.TEAM_KEY || '';
app.get('/api/team', async (req, res) => {
  // No login needed, but if TEAM_KEY is set the link must carry ?k=TEAM_KEY (the GHL menu link does).
  if (!req.user && TEAM_KEY && !safeEq(String(req.query.k || ''), TEAM_KEY)) return res.status(401).json({ error: 'Open the team board from GHL, or sign in.' });
  try {
    const period = ['month', 'quarter', 'all'].includes(req.query.period) ? req.query.period : 'month';
    const data = await build(req.query.refresh === '1' && !!req.user);
    const owner = req.user?.role === 'owner';
    const me = req.user?.role === 'rep' ? req.user.name : null;
    res.json(teamView(data, period, owner || TEAM_SHOW_PAY, me));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/deals', needUser, async (req, res) => {
  try {
    const data = await build(req.query.refresh === '1');
    if (req.user.role === 'owner') {
      if (req.query.as) return res.json({ ...repView(data, req.query.as), previewBy: 'owner' });
      return res.json(ownerView(data));
    }
    res.json(repView(data, req.user.name));
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

async function setFields(id, values) {
  if (DEMO) {
    const d = demoDeals.find((x) => x.id === id);
    if (!d) throw Object.assign(new Error('Not found'), { status: 404 });
    Object.assign(d.fields, values);
  } else {
    if (!ghl.fieldMap) await ghl.loadFields();
    await ghl.updateFields(id, values);
  }
  cache.at = 0;
}

app.post('/api/deals/:id/missed', needUser, needOwner, async (req, res) => {
  try {
    const data = await build();
    const d = data.deals.find((x) => x.id === req.params.id);
    if (!d) return res.status(404).json({ error: 'Deal not found' });
    await setFields(d.id, { missed_payments: Math.max(0, (d.calc.missed || 0) + (Number(req.body.delta) || 0)) });
    res.json(ownerView(await build(true)));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/deals/:id/status', needUser, needOwner, async (req, res) => {
  if (!['Performing', 'Slow Pay', 'Default', 'Paid Off'].includes(req.body.status)) return res.status(400).json({ error: 'Bad status' });
  try { await setFields(req.params.id, { payment_status: req.body.status }); res.json(ownerView(await build(true))); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/health', async (req, res) => {
  if (DEMO) return res.json({ ok: true, demo: true });
  try { const r = await ghl.loadFields(); res.json({ ok: true, ...r, reps: Object.keys(REP_PASSWORDS).length }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.listen(PORT, () => console.log(`Capital Gateway dashboard on :${PORT}${DEMO ? ' (DEMO — owner pw "owner", reps by first name)' : ''}`));
