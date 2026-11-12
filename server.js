require('dotenv').config();
const express = require('express');
const path = require('path');
const { GHL } = require('./lib/ghl');
const { computeDeal, computedWriteback, round2 } = require('./lib/calc');

const PORT = process.env.PORT || 3000;
const DEMO = String(process.env.DEMO_MODE || '').toLowerCase() === 'true' || !process.env.GHL_TOKEN;
const LOCATION_ID = process.env.GHL_LOCATION_ID || 'WUqaLeDuJ5H8kocqpip7';
const CACHE_MS = Number(process.env.CACHE_SECONDS || 120) * 1000;
const AUTO_WRITEBACK = String(process.env.AUTO_WRITEBACK || 'true').toLowerCase() === 'true';

const ghl = DEMO ? null : new GHL({ token: process.env.GHL_TOKEN, locationId: LOCATION_ID });
const demoDeals = DEMO ? JSON.parse(JSON.stringify(require('./lib/demo'))) : null;

const app = express();
app.use(express.json());

// Simple shared-password gate (HTTP basic auth). Username can be anything.
if (process.env.DASHBOARD_PASSWORD) {
  app.use((req, res, next) => {
    const hdr = req.headers.authorization || '';
    const [, b64] = hdr.split(' ');
    const pass = b64 ? Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':') : '';
    if (pass === process.env.DASHBOARD_PASSWORD) return next();
    res.set('WWW-Authenticate', 'Basic realm="Capital Gateway Dashboard"').status(401).send('Login required');
  });
}

app.use(express.static(path.join(__dirname, 'public')));

let cache = { at: 0, data: null };

async function loadRaw() {
  if (DEMO) return demoDeals.map((d) => ({ ...d, fields: { ...d.fields } }));
  if (!ghl.fieldMap) await ghl.loadFields();
  const [opps, pipelines] = await Promise.all([ghl.allOpportunities(), ghl.listPipelines()]);
  const stageName = {};
  const pipeName = {};
  for (const p of pipelines) {
    pipeName[p.id] = p.name;
    for (const s of p.stages || []) stageName[s.id] = s.name;
  }
  return opps
    .map((o) => ({
      id: o.id,
      name: o.name || o.contact?.businessName || o.contact?.name || 'Untitled',
      contactId: o.contactId || o.contact?.id,
      stage: stageName[o.pipelineStageId] || '',
      pipeline: pipeName[o.pipelineId] || '',
      status: o.status,
      fields: ghl.flatten(o),
    }))
    .filter((o) => o.fields.funded_amount !== undefined && o.fields.funded_amount !== null && o.fields.funded_amount !== '');
}

async function build(force = false) {
  if (!force && cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;
  const raw = await loadRaw();
  const deals = raw.map((r) => ({ ...r, calc: computeDeal(r.fields) }));

  // Fill blank $ fields in GHL with the computed values so GHL reports match the dashboard.
  if (!DEMO && AUTO_WRITEBACK) {
    for (const d of deals) {
      const wb = computedWriteback(d.fields, d.calc);
      if (Object.keys(wb).length) {
        try { await ghl.updateFields(d.id, wb); Object.assign(d.fields, wb); }
        catch (e) { console.error('writeback failed', d.id, e.message); }
      }
    }
  }

  const sum = (fn) => round2(deals.reduce((s, d) => s + (fn(d) || 0), 0));
  const active = deals.filter((d) => !['Paid Off', 'Default'].includes(d.calc.status));
  const totals = {
    deals: deals.length,
    active: active.length,
    funded: sum((d) => d.calc.funded),
    rtr: sum((d) => d.calc.rtr),
    collected: sum((d) => d.calc.collected),
    outstanding: sum((d) => (d.calc.status === 'Paid Off' ? 0 : d.calc.balance)),
    commission: sum((d) => d.calc.commission),
    repPayouts: sum((d) => d.calc.repTotal),
    house: sum((d) => d.calc.house),
    missed: deals.reduce((s, d) => s + d.calc.missed, 0),
    defaults: deals.filter((d) => d.calc.status === 'Default').length,
    renewalEligible: deals.filter((d) => d.calc.renewalEligible && d.calc.status !== 'Paid Off').length,
  };

  const reps = {};
  const credit = (agent, role, amount, deal) => {
    if (!agent) return;
    reps[agent] = reps[agent] || { agent, openerDeals: 0, closerDeals: 0, earned: 0, fundedCredited: 0, deals: [] };
    const r = reps[agent];
    if (role === 'Opener') r.openerDeals++; else r.closerDeals++;
    r.earned = round2(r.earned + (amount || 0));
    r.fundedCredited = round2(r.fundedCredited + (deal.calc.funded || 0));
    r.deals.push({ id: deal.id, name: deal.name, role, amount });
  };
  for (const d of deals) {
    if (d.calc.opener) credit(d.calc.opener.agent, 'Opener', d.calc.opener.amount, d);
    for (const c of d.calc.closers) credit(c.agent, `Closer ${c.slot}`, c.amount, d);
  }

  cache = {
    at: Date.now(),
    data: {
      generatedAt: new Date().toISOString(),
      demo: DEMO,
      locationId: LOCATION_ID,
      totals,
      reps: Object.values(reps).sort((a, b) => b.earned - a.earned),
      deals: deals.sort((a, b) => String(b.calc.fundedDate).localeCompare(String(a.calc.fundedDate))),
    },
  };
  return cache.data;
}

app.get('/api/deals', async (req, res) => {
  try { res.json(await build(req.query.refresh === '1')); }
  catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
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

app.post('/api/deals/:id/missed', async (req, res) => {
  try {
    const data = await build();
    const d = data.deals.find((x) => x.id === req.params.id);
    if (!d) return res.status(404).json({ error: 'Deal not found' });
    const next = Math.max(0, (d.calc.missed || 0) + (Number(req.body.delta) || 0));
    await setFields(d.id, { missed_payments: next });
    res.json(await build(true));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/deals/:id/status', async (req, res) => {
  const allowed = ['Performing', 'Slow Pay', 'Default', 'Paid Off'];
  if (!allowed.includes(req.body.status)) return res.status(400).json({ error: 'Bad status' });
  try { await setFields(req.params.id, { payment_status: req.body.status }); res.json(await build(true)); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/health', async (req, res) => {
  if (DEMO) return res.json({ ok: true, demo: true });
  try { const r = await ghl.loadFields(); res.json({ ok: true, ...r }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.listen(PORT, () => console.log(`Capital Gateway dashboard on :${PORT}${DEMO ? ' (DEMO MODE — sample data)' : ''}`));
