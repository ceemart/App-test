const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../js/core.js');

test('parseMoney handles common inputs', () => {
  assert.equal(Core.parseMoney('12'), 1200);
  assert.equal(Core.parseMoney('$1,234.56'), 123456);
  assert.equal(Core.parseMoney('-3.5'), -350);
  assert.equal(Core.parseMoney('(4.20)'), -420);
  assert.equal(Core.parseMoney('.99'), 99);
  assert.ok(Number.isNaN(Core.parseMoney('abc')));
  assert.ok(Number.isNaN(Core.parseMoney('1.234')));
  assert.ok(Number.isNaN(Core.parseMoney('')));
});

test('centsToInput round-trips with parseMoney', () => {
  for (const c of [0, 5, 99, 100, 123456, -250]) {
    assert.equal(Core.parseMoney(Core.centsToInput(c)), c);
  }
});

test('addMonths clamps to end of month', () => {
  assert.equal(Core.addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(Core.addMonths('2024-01-31', 1), '2024-02-29');
  assert.equal(Core.addMonths('2026-11-15', 2), '2027-01-15');
});

test('advanceDate by frequency', () => {
  assert.equal(Core.advanceDate('2026-10-01', 'weekly'), '2026-10-08');
  assert.equal(Core.advanceDate('2026-10-01', 'biweekly'), '2026-10-15');
  assert.equal(Core.advanceDate('2026-10-01', 'monthly'), '2026-11-01');
  assert.equal(Core.advanceDate('2026-10-01', 'quarterly'), '2027-01-01');
  assert.equal(Core.advanceDate('2026-10-01', 'yearly'), '2027-10-01');
});

test('account balances account for income, expenses and transfers', () => {
  const s = Core.defaultState();
  s.accounts = [
    { id: 'a', name: 'Checking', type: 'checking', opening: 10000 },
    { id: 'b', name: 'Savings', type: 'savings', opening: 0 },
  ];
  s.transactions = [
    { id: '1', date: '2026-10-01', amount: 5000, type: 'income', accountId: 'a' },
    { id: '2', date: '2026-10-02', amount: 2000, type: 'expense', accountId: 'a', categoryId: 'x' },
    { id: '3', date: '2026-10-03', amount: 3000, type: 'transfer', accountId: 'a', toAccountId: 'b' },
  ];
  assert.equal(Core.accountBalance(s, 'a'), 10000);
  assert.equal(Core.accountBalance(s, 'b'), 3000);
  assert.equal(Core.netWorth(s), 13000);
});

test('monthSummary ignores transfers and other months', () => {
  const s = Core.defaultState();
  s.transactions = [
    { date: '2026-10-01', amount: 5000, type: 'income' },
    { date: '2026-10-02', amount: 2000, type: 'expense', categoryId: 'g' },
    { date: '2026-10-05', amount: 500, type: 'expense', categoryId: 'g' },
    { date: '2026-10-03', amount: 3000, type: 'transfer' },
    { date: '2026-09-30', amount: 9999, type: 'expense', categoryId: 'g' },
  ];
  const sum = Core.monthSummary(s, '2026-10');
  assert.deepEqual(sum, { income: 5000, expense: 2500, net: 2500, byCategory: { g: 2500 } });
});

test('budgetStatus thresholds', () => {
  assert.equal(Core.budgetStatus(100, 0), 'none');
  assert.equal(Core.budgetStatus(50, 100), 'ok');
  assert.equal(Core.budgetStatus(85, 100), 'warning');
  assert.equal(Core.budgetStatus(100, 100), 'warning');
  assert.equal(Core.budgetStatus(101, 100), 'over');
});

test('goalMonthlyNeeded', () => {
  assert.equal(Core.goalMonthlyNeeded({ target: 120000, saved: 0, deadline: '2027-10-01' }, '2026-10-01'), 10000);
  assert.equal(Core.goalMonthlyNeeded({ target: 100, saved: 100, deadline: '' }, '2026-10-01'), 0);
  assert.equal(Core.goalMonthlyNeeded({ target: 100, saved: 0, deadline: '' }, '2026-10-01'), null);
});

test('CSV export then import round-trips', () => {
  const s = Core.sampleState('2026-10-01');
  const csv = Core.transactionsToCSV(s, s.transactions);
  const fresh = Core.defaultState();
  const result = Core.importTransactionsCSV(fresh, csv);
  assert.equal(result.added, s.transactions.length);
  assert.equal(result.skipped, 0);
  const total = (st, type) => st.transactions.filter((t) => t.type === type).reduce((a, t) => a + t.amount, 0);
  assert.equal(total(fresh, 'expense'), total(s, 'expense'));
  assert.equal(total(fresh, 'income'), total(s, 'income'));
  assert.equal(total(fresh, 'transfer'), total(s, 'transfer'));
});

test('importTransactionsCSV understands a typical bank export', () => {
  const s = Core.defaultState();
  const csv = 'Posted Date,Payee,Debit,Credit\n10/02/2026,"Coffee, Inc",4.50,\n10/03/2026,Employer,,1500.00\n,bad row,1,\n';
  const r = Core.importTransactionsCSV(s, csv, { accountId: s.accounts[0].id });
  assert.equal(r.added, 2);
  assert.equal(r.skipped, 1);
  const [coffee, pay] = s.transactions;
  assert.deepEqual([coffee.date, coffee.desc, coffee.amount, coffee.type], ['2026-10-02', 'Coffee, Inc', 450, 'expense']);
  assert.deepEqual([pay.amount, pay.type, pay.accountId], [150000, 'income', s.accounts[0].id]);
});

test('normalizeState rejects junk and fills defaults', () => {
  assert.throws(() => Core.normalizeState(null));
  const s = Core.normalizeState({ currency: 'bad', transactions: [{ date: 'nope' }, { date: '2026-01-01', amount: -5 }] });
  assert.equal(s.currency, 'USD');
  assert.equal(s.transactions.length, 1);
  assert.equal(s.transactions[0].amount, 5);
  assert.ok(s.accounts.length > 0 && s.categories.length > 0);
});

test('sample data never contains future transactions', () => {
  const s = Core.sampleState('2026-10-01');
  assert.ok(s.transactions.every((t) => t.date <= '2026-10-01'));
  assert.ok(s.bills.every((b) => b.nextDue > '2026-10-01'));
});
