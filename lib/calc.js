// Deal math for Capital Gateway's commission & payment dashboard.
// All money in dollars (floats rounded to cents at the edges).

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[$,%\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

// Count business days (Mon–Fri) strictly after `start` up to and including `end`.
function businessDaysBetween(start, end) {
  if (end <= start) return 0;
  let count = 0;
  const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const last = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  while (true) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getTime() > last) break;
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

function addBusinessDays(start, n) {
  const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  let added = 0;
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return d;
}

function parseDate(v) {
  if (!v) return null;
  if (typeof v === 'number') return new Date(v);
  const s = String(v);
  // GHL date fields come back as ISO strings or epoch ms strings
  if (/^\d{10,13}$/.test(s)) return new Date(Number(s.length === 10 ? s + '000' : s));
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

// Total number of scheduled payments for the deal.
// Daily payments are business days (ACH). A term in weeks with daily payments = weeks × 5.
function totalPayments(frequency, termLength, termUnit) {
  if (!termLength) return null;
  const freq = (frequency || '').toLowerCase().startsWith('week') ? 'weekly' : 'daily';
  const unit = (termUnit || '').toLowerCase().startsWith('week') ? 'weeks'
    : (termUnit || '').toLowerCase().startsWith('day') ? 'days'
    : (freq === 'weekly' ? 'weeks' : 'days');
  if (freq === 'daily') return unit === 'weeks' ? termLength * 5 : termLength;
  return unit === 'weeks' ? termLength : Math.ceil(termLength / 5);
}

/**
 * f = flat object of field values keyed by GHL field key (funded_amount, factor_rate, …)
 * Returns the computed deal. Entered $ values always win over computed ones.
 */
function computeDeal(f, today = new Date()) {
  const funded = num(f.funded_amount);
  const factor = num(f.factor_rate);
  const rtr = num(f.rtr) ?? (funded != null && factor != null ? round2(funded * factor) : null);
  const frequency = (f.payment_frequency || '').toLowerCase().startsWith('week') ? 'Weekly' : (f.payment_frequency ? 'Daily' : null);
  const termLength = num(f.term_length);
  const termUnit = f.term_unit || null;
  const nPayments = totalPayments(frequency, termLength, termUnit);
  const payment = num(f.payment_amount) ?? (rtr != null && nPayments ? round2(rtr / nPayments) : null);
  const fundedDate = parseDate(f.funded_date);
  const missed = Math.max(0, num(f.missed_payments) || 0);
  const status = f.payment_status || 'Performing';

  // Expected payments due to date
  let due = 0;
  if (fundedDate && nPayments) {
    if (frequency === 'Weekly') {
      const days = Math.floor((today - fundedDate) / 86400000);
      due = Math.max(0, Math.floor(days / 7));
    } else {
      due = businessDaysBetween(fundedDate, today);
    }
    due = Math.min(due, nPayments);
  }
  let made = Math.max(0, due - missed);
  let collected = payment != null ? round2(Math.min(made * payment, rtr ?? Infinity)) : null;
  if (status === 'Paid Off' && rtr != null) { collected = rtr; made = nPayments ?? made; }
  const balance = rtr != null && collected != null ? round2(Math.max(0, rtr - collected)) : null;
  const pctPaid = rtr ? Math.min(1, (collected || 0) / rtr) : 0;

  let finalDate = null;
  if (fundedDate && nPayments) {
    const remaining = nPayments + missed; // missed payments push the schedule out
    finalDate = frequency === 'Weekly'
      ? new Date(fundedDate.getTime() + remaining * 7 * 86400000)
      : addBusinessDays(fundedDate, remaining);
  }

  // Commissions
  const commissionPct = num(f.commission_pct);
  const commission = num(f.commission_amount) ?? (funded != null && commissionPct != null ? round2(funded * commissionPct / 100) : null);
  const split = (agent, pct, amount) => {
    if (!agent) return null;
    const p = num(pct);
    const a = num(amount) ?? (commission != null && p != null ? round2(commission * p / 100) : null);
    return { agent, pct: p, amount: a };
  };
  const opener = split(f.opener_agent, f.opener_pct, f.opener_amount);
  const closers = [1, 2, 3]
    .map((i) => { const s = split(f[`closer_${i}_agent`], f[`closer_${i}_pct`], f[`closer_${i}_amount`]); return s && { ...s, slot: i }; })
    .filter(Boolean);
  const splitPct = (opener?.pct || 0) + closers.reduce((s, c) => s + (c.pct || 0), 0);
  const repTotal = round2((opener?.amount || 0) + closers.reduce((s, c) => s + (c.amount || 0), 0));
  const house = commission != null ? round2(commission - repTotal) : null;

  const warnings = [];
  if (funded == null) warnings.push('Missing Funded Amount');
  if (factor == null && num(f.rtr) == null) warnings.push('Missing Factor Rate');
  if (!fundedDate) warnings.push('Missing Funded Date');
  if (!nPayments) warnings.push('Missing Term Length');
  if (!f.payment_frequency) warnings.push('Missing Payment Frequency');
  if (splitPct > 100.0001) warnings.push(`Rep splits add to ${splitPct}% (over 100%)`);

  return {
    funded, factor, rtr, frequency, termLength, termUnit, nPayments, payment,
    fundedDate: fundedDate ? fundedDate.toISOString().slice(0, 10) : null,
    finalDate: finalDate ? finalDate.toISOString().slice(0, 10) : null,
    due, missed, made, collected, balance, pctPaid,
    renewalEligible: pctPaid >= 0.5 && status !== 'Default',
    status,
    commissionPct, commission, opener, closers, splitPct, repTotal, house,
    warnings,
  };
}

// Values the dashboard can write back into GHL $ fields when they are blank.
function computedWriteback(f, d) {
  const out = {};
  if (num(f.rtr) == null && d.rtr != null) out.rtr = d.rtr;
  if (num(f.payment_amount) == null && d.payment != null) out.payment_amount = d.payment;
  if (num(f.commission_amount) == null && d.commission != null) out.commission_amount = d.commission;
  if (d.opener && num(f.opener_amount) == null && d.opener.amount != null) out.opener_amount = d.opener.amount;
  [1, 2, 3].forEach((i) => {
    const c = d.closers.find((x) => x.slot === i);
    if (c && num(f[`closer_${i}_amount`]) == null && c.amount != null) out[`closer_${i}_amount`] = c.amount;
  });
  return out;
}

module.exports = { computeDeal, computedWriteback, businessDaysBetween, totalPayments, round2 };
