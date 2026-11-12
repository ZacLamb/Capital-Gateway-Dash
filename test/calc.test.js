const assert = require('assert');
const { computeDeal, businessDaysBetween, totalPayments } = require('../lib/calc');

// Worked example: $50,000 funded at 1.35 → RTR $67,500; 120 daily payments → $562.50/payment.
// 10% commission = $5,000; opener 40% = $2,000; closer 30% = $1,500; closer 20% = $1,000; house $500.
const today = new Date('2026-11-12T12:00:00Z'); // Thursday
const d = computeDeal({
  funded_amount: 50000, factor_rate: 1.35, payment_frequency: 'Daily', term_length: 120, term_unit: 'Days',
  funded_date: '2026-11-02', missed_payments: 1, commission_pct: 10,
  opener_agent: 'A', opener_pct: 40, closer_1_agent: 'B', closer_1_pct: 30, closer_2_agent: 'C', closer_2_pct: 20,
}, today);
assert.strictEqual(d.rtr, 67500);
assert.strictEqual(d.nPayments, 120);
assert.strictEqual(d.payment, 562.5);
assert.strictEqual(d.due, 8);          // Nov 3–6 (4) + Nov 9–12 (4)
assert.strictEqual(d.made, 7);
assert.strictEqual(d.collected, 3937.5);
assert.strictEqual(d.balance, 63562.5);
assert.strictEqual(d.commission, 5000);
assert.strictEqual(d.opener.amount, 2000);
assert.deepStrictEqual(d.closers.map((c) => c.amount), [1500, 1000]);
assert.strictEqual(d.house, 500);

// Weekly
const w = computeDeal({ funded_amount: 85000, factor_rate: 1.42, payment_frequency: 'Weekly', term_length: 32, term_unit: 'Weeks', funded_date: '2026-09-03' }, today);
assert.strictEqual(w.rtr, 120700);
assert.strictEqual(w.payment, 3771.88);
assert.strictEqual(w.due, 10);

// Entered values win over computed
const e = computeDeal({ funded_amount: 10000, factor_rate: 1.4, rtr: 14500, commission_amount: 1234, payment_frequency: 'Daily', term_length: 100, term_unit: 'Days' }, today);
assert.strictEqual(e.rtr, 14500);
assert.strictEqual(e.commission, 1234);

// Paid off
const p = computeDeal({ funded_amount: 15000, factor_rate: 1.45, payment_frequency: 'Daily', term_length: 90, term_unit: 'Days', funded_date: '2026-11-10', payment_status: 'Paid Off' }, today);
assert.strictEqual(p.balance, 0);

assert.strictEqual(totalPayments('Daily', 24, 'Weeks'), 120);
assert.strictEqual(totalPayments('Weekly', 120, 'Days'), 24);
assert.strictEqual(businessDaysBetween(new Date('2026-11-06T00:00Z'), new Date('2026-11-09T00:00Z')), 1);
console.log('calc tests passed');
