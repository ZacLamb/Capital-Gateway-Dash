// Sample deals so the dashboard can be previewed (DEMO_MODE=true) before the GHL token is in place.
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

const deals = [
  ['Sunrise Bakery LLC', 'Funded', { funded_amount: 50000, funded_date: daysAgo(45), factor_rate: 1.35, payment_frequency: 'Daily', term_length: 120, term_unit: 'Days', commission_pct: 10, opener_agent: 'Aaron Meckler', opener_pct: 40, closer_1_agent: 'Daniel Talkins', closer_1_pct: 30, closer_2_agent: 'John Elfassi', closer_2_pct: 20, payment_status: 'Performing', missed_payments: 0 }],
  ['Bayside Auto Repair', 'Funded', { funded_amount: 85000, funded_date: daysAgo(70), factor_rate: 1.42, payment_frequency: 'Weekly', term_length: 32, term_unit: 'Weeks', commission_pct: 12, opener_agent: 'Steve Gordon', opener_pct: 40, closer_1_agent: 'Aaron Meckler', closer_1_pct: 40, payment_status: 'Performing', missed_payments: 0 }],
  ['Miami Fresh Produce Inc', 'Funded', { funded_amount: 30000, funded_date: daysAgo(30), factor_rate: 1.38, payment_frequency: 'Daily', term_length: 100, term_unit: 'Days', commission_pct: 10, opener_agent: 'John Elfassi', opener_pct: 50, closer_1_agent: 'Steve Gordon', closer_1_pct: 30, payment_status: 'Slow Pay', missed_payments: 4 }],
  ['Coastal Roofing Co', 'Funded', { funded_amount: 120000, funded_date: daysAgo(120), factor_rate: 1.30, payment_frequency: 'Weekly', term_length: 26, term_unit: 'Weeks', commission_pct: 8, opener_agent: 'Daniel Talkins', opener_pct: 40, closer_1_agent: 'Aaron Meckler', closer_1_pct: 25, closer_2_agent: 'Steve Gordon', closer_2_pct: 15, closer_3_agent: 'John Elfassi', closer_3_pct: 10, payment_status: 'Performing', missed_payments: 1 }],
  ['Elite Nail Spa', 'Funded', { funded_amount: 15000, funded_date: daysAgo(160), factor_rate: 1.45, payment_frequency: 'Daily', term_length: 90, term_unit: 'Days', commission_pct: 12, opener_agent: 'Aaron Meckler', opener_pct: 50, closer_1_agent: 'John Elfassi', closer_1_pct: 30, payment_status: 'Paid Off', missed_payments: 0 }],
  ['Hallandale Logistics', 'Funded', { funded_amount: 65000, funded_date: daysAgo(55), factor_rate: 1.40, payment_frequency: 'Daily', term_length: 140, term_unit: 'Days', commission_pct: 10, opener_agent: 'Steve Gordon', opener_pct: 40, closer_1_agent: 'Daniel Talkins', closer_1_pct: 40, payment_status: 'Default', missed_payments: 18 }],
  ['Brickell Dental Group', 'Funded', { funded_amount: 40000, funded_date: daysAgo(8), factor_rate: 1.32, payment_frequency: 'Weekly', term_length: 20, term_unit: 'Weeks', commission_pct: 10, opener_agent: 'Daniel Talkins', opener_pct: 45, closer_1_agent: 'John Elfassi', closer_1_pct: 35, payment_status: 'Performing', missed_payments: 0 }],
];

module.exports = deals.map(([name, stage, fields], i) => ({
  id: `demo-${i + 1}`, name, stage, pipeline: 'MCA Pipeline', status: 'won', fields,
}));
