/*
 * Core finance logic — pure functions with no DOM access.
 * All money values are stored as integer cents to avoid floating-point drift.
 * Works in the browser (window.Core) and in Node (module.exports) for tests.
 */
(function (root) {
  'use strict';

  const SCHEMA_VERSION = 1;

  const ACCOUNT_TYPES = ['checking', 'savings', 'credit', 'cash', 'investment'];
  const TX_TYPES = ['expense', 'income', 'transfer'];
  const FREQUENCIES = ['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'];

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // ---------- Money ----------

  /** Parse user input like "1,234.56", "$12", "-3.5" into integer cents. Returns NaN if invalid. */
  function parseMoney(input) {
    if (typeof input === 'number') return Math.round(input * 100);
    if (typeof input !== 'string') return NaN;
    let s = input.trim();
    let negative = false;
    if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
    s = s.replace(/[\s,$€£¥]/g, '');
    if (s.startsWith('-')) { negative = !negative; s = s.slice(1); }
    if (!/^\d*(\.\d{0,2})?$/.test(s) || s === '' || s === '.') return NaN;
    const [whole, frac = ''] = s.split('.');
    const cents = parseInt(whole || '0', 10) * 100 + parseInt((frac + '00').slice(0, 2), 10);
    return negative ? -cents : cents;
  }

  function formatMoney(cents, currency) {
    const value = (cents || 0) / 100;
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD' }).format(value);
    } catch (e) {
      return value.toFixed(2);
    }
  }

  /** Cents to a plain editable string, e.g. 123456 -> "1234.56". */
  function centsToInput(cents) {
    if (cents == null || isNaN(cents)) return '';
    const sign = cents < 0 ? '-' : '';
    const abs = Math.abs(cents);
    return sign + Math.floor(abs / 100) + '.' + String(abs % 100).padStart(2, '0');
  }

  // ---------- Dates (all as local YYYY-MM-DD strings) ----------

  function pad(n) { return String(n).padStart(2, '0'); }

  function toISODate(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function parseISODate(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function today() { return toISODate(new Date()); }

  function monthKey(dateStr) { return dateStr.slice(0, 7); }

  function shiftMonth(month, delta) {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1);
  }

  function monthLabel(month, style) {
    const [y, m] = month.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString(undefined,
      style === 'short' ? { month: 'short' } : { month: 'long', year: 'numeric' });
  }

  function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); }

  /** Add whole months, clamping the day (Jan 31 + 1 month = Feb 28/29). */
  function addMonths(dateStr, n) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const target = new Date(y, m - 1 + n, 1);
    const day = Math.min(d, daysInMonth(target.getFullYear(), target.getMonth() + 1));
    return target.getFullYear() + '-' + pad(target.getMonth() + 1) + '-' + pad(day);
  }

  function addDays(dateStr, n) {
    const d = parseISODate(dateStr);
    d.setDate(d.getDate() + n);
    return toISODate(d);
  }

  function daysBetween(a, b) {
    return Math.round((parseISODate(b) - parseISODate(a)) / 86400000);
  }

  function advanceDate(dateStr, frequency) {
    switch (frequency) {
      case 'weekly': return addDays(dateStr, 7);
      case 'biweekly': return addDays(dateStr, 14);
      case 'quarterly': return addMonths(dateStr, 3);
      case 'yearly': return addMonths(dateStr, 12);
      case 'monthly':
      default: return addMonths(dateStr, 1);
    }
  }

  /** Approximate monthly cost of a recurring bill. */
  function monthlyEquivalent(amount, frequency) {
    switch (frequency) {
      case 'weekly': return Math.round(amount * 52 / 12);
      case 'biweekly': return Math.round(amount * 26 / 12);
      case 'quarterly': return Math.round(amount / 3);
      case 'yearly': return Math.round(amount / 12);
      default: return amount;
    }
  }

  // ---------- State ----------

  function defaultState() {
    const c = (name, kind, budget) => ({ id: uid(), name, kind, budget: budget || 0 });
    return {
      version: SCHEMA_VERSION,
      currency: 'USD',
      theme: 'system',
      members: [{ id: uid(), name: 'Shared' }],
      accounts: [{ id: uid(), name: 'Checking', type: 'checking', opening: 0 }],
      categories: [
        c('Salary', 'income'), c('Other Income', 'income'),
        c('Housing', 'expense'), c('Utilities', 'expense'), c('Groceries', 'expense'),
        c('Dining Out', 'expense'), c('Transportation', 'expense'), c('Health', 'expense'),
        c('Insurance', 'expense'), c('Kids & Education', 'expense'), c('Shopping', 'expense'),
        c('Entertainment', 'expense'), c('Subscriptions', 'expense'), c('Gifts & Donations', 'expense'),
        c('Travel', 'expense'), c('Miscellaneous', 'expense'),
      ],
      transactions: [],
      bills: [],
      goals: [],
    };
  }

  /** Validate and normalise a loaded/imported state object. Throws on unusable input. */
  function normalizeState(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('Not a valid backup file.');
    const base = defaultState();
    const arr = (v) => (Array.isArray(v) ? v : []);
    const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);
    const str = (v) => (v == null ? '' : String(v));
    const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

    const state = {
      version: SCHEMA_VERSION,
      currency: typeof raw.currency === 'string' && /^[A-Z]{3}$/.test(raw.currency) ? raw.currency : 'USD',
      theme: ['system', 'light', 'dark'].includes(raw.theme) ? raw.theme : 'system',
      members: arr(raw.members).map((m) => ({ id: str(m.id) || uid(), name: str(m.name) || 'Member' })),
      accounts: arr(raw.accounts).map((a) => ({
        id: str(a.id) || uid(), name: str(a.name) || 'Account',
        type: ACCOUNT_TYPES.includes(a.type) ? a.type : 'checking', opening: int(a.opening),
      })),
      categories: arr(raw.categories).map((c) => ({
        id: str(c.id) || uid(), name: str(c.name) || 'Category',
        kind: c.kind === 'income' ? 'income' : 'expense', budget: Math.max(0, int(c.budget)),
      })),
      transactions: arr(raw.transactions).filter((t) => isDate(t.date)).map((t) => ({
        id: str(t.id) || uid(), date: t.date, desc: str(t.desc),
        amount: Math.abs(int(t.amount)), type: TX_TYPES.includes(t.type) ? t.type : 'expense',
        categoryId: str(t.categoryId), accountId: str(t.accountId), toAccountId: str(t.toAccountId),
        memberId: str(t.memberId), notes: str(t.notes),
      })),
      bills: arr(raw.bills).filter((b) => isDate(b.nextDue)).map((b) => ({
        id: str(b.id) || uid(), name: str(b.name) || 'Bill', amount: Math.abs(int(b.amount)),
        categoryId: str(b.categoryId), accountId: str(b.accountId), memberId: str(b.memberId),
        frequency: FREQUENCIES.includes(b.frequency) ? b.frequency : 'monthly', nextDue: b.nextDue,
      })),
      goals: arr(raw.goals).map((g) => ({
        id: str(g.id) || uid(), name: str(g.name) || 'Goal', target: Math.max(0, int(g.target)),
        saved: Math.max(0, int(g.saved)), deadline: isDate(g.deadline) ? g.deadline : '',
      })),
    };
    if (!state.members.length) state.members = base.members;
    if (!state.accounts.length) state.accounts = base.accounts;
    if (!state.categories.length) state.categories = base.categories;
    return state;
  }

  // ---------- Calculations ----------

  /** Signed effect of a transaction on a given account. */
  function txEffect(tx, accountId) {
    if (tx.type === 'transfer') {
      let e = 0;
      if (tx.accountId === accountId) e -= tx.amount;
      if (tx.toAccountId === accountId) e += tx.amount;
      return e;
    }
    if (tx.accountId !== accountId) return 0;
    return tx.type === 'income' ? tx.amount : -tx.amount;
  }

  function accountBalance(state, accountId) {
    const acct = state.accounts.find((a) => a.id === accountId);
    let bal = acct ? acct.opening : 0;
    for (const tx of state.transactions) bal += txEffect(tx, accountId);
    return bal;
  }

  /** Net worth = sum of all account balances (credit cards carry negative balances). */
  function netWorth(state) {
    return state.accounts.reduce((sum, a) => sum + accountBalance(state, a.id), 0);
  }

  function monthSummary(state, month) {
    let income = 0, expense = 0;
    const byCategory = {};
    for (const tx of state.transactions) {
      if (monthKey(tx.date) !== month || tx.type === 'transfer') continue;
      if (tx.type === 'income') income += tx.amount;
      else {
        expense += tx.amount;
        byCategory[tx.categoryId] = (byCategory[tx.categoryId] || 0) + tx.amount;
      }
    }
    return { income, expense, net: income - expense, byCategory };
  }

  function spendingByMember(state, month) {
    const out = {};
    for (const tx of state.transactions) {
      if (tx.type !== 'expense' || monthKey(tx.date) !== month) continue;
      out[tx.memberId] = (out[tx.memberId] || 0) + tx.amount;
    }
    return out;
  }

  /** Income/expense for the `count` months ending at `endMonth`, oldest first. */
  function monthlyTrend(state, endMonth, count) {
    const out = [];
    for (let i = count - 1; i >= 0; i--) {
      const month = shiftMonth(endMonth, -i);
      const s = monthSummary(state, month);
      out.push({ month, income: s.income, expense: s.expense, net: s.net });
    }
    return out;
  }

  /** 'ok' under 85%, 'warning' 85–100%, 'over' above budget, 'none' when no budget is set. */
  function budgetStatus(spent, budget) {
    if (!budget) return 'none';
    const ratio = spent / budget;
    if (ratio > 1) return 'over';
    if (ratio >= 0.85) return 'warning';
    return 'ok';
  }

  function upcomingBills(state, fromDate, withinDays) {
    return state.bills
      .map((b) => ({ ...b, daysUntil: daysBetween(fromDate, b.nextDue) }))
      .filter((b) => b.daysUntil <= withinDays)
      .sort((a, b) => a.nextDue.localeCompare(b.nextDue));
  }

  /** Monthly amount needed to reach a goal by its deadline (null if no deadline). */
  function goalMonthlyNeeded(goal, fromDate) {
    const remaining = Math.max(0, goal.target - goal.saved);
    if (!goal.deadline || remaining === 0) return remaining === 0 ? 0 : null;
    const [fy, fm] = fromDate.split('-').map(Number);
    const [dy, dm] = goal.deadline.split('-').map(Number);
    const months = Math.max(1, (dy - fy) * 12 + (dm - fm));
    return Math.ceil(remaining / months);
  }

  // ---------- CSV ----------

  function csvEscape(v) {
    const s = String(v == null ? '' : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function parseCSV(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
        } else field += ch;
      } else if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += ch;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((c) => c.trim() !== ''));
  }

  const CSV_HEADER = ['Date', 'Description', 'Type', 'Amount', 'Category', 'Account', 'To Account', 'Member', 'Notes'];

  function transactionsToCSV(state, transactions) {
    const name = (list, id) => (list.find((x) => x.id === id) || {}).name || '';
    const lines = [CSV_HEADER.join(',')];
    for (const t of transactions) {
      lines.push([
        t.date, t.desc, t.type, centsToInput(t.amount), name(state.categories, t.categoryId),
        name(state.accounts, t.accountId), name(state.accounts, t.toAccountId),
        name(state.members, t.memberId), t.notes,
      ].map(csvEscape).join(','));
    }
    return lines.join('\n');
  }

  /** Normalise common bank date formats to YYYY-MM-DD. */
  function normalizeDate(s) {
    s = (s || '').trim();
    let m;
    if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) return m[1] + '-' + pad(+m[2]) + '-' + pad(+m[3]);
    if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/))) {
      const y = m[3].length === 2 ? '20' + m[3] : m[3];
      return y + '-' + pad(+m[1]) + '-' + pad(+m[2]); // assumes US month/day order
    }
    return '';
  }

  /**
   * Import transactions from CSV. Accepts this app's own export format, or any bank CSV with
   * at least Date, Description and Amount columns (negative amounts = expenses).
   * Unknown category/account/member names are created. Returns { added, skipped, created }.
   */
  function importTransactionsCSV(state, text, defaults) {
    defaults = defaults || {};
    const rows = parseCSV(text);
    if (!rows.length) return { added: 0, skipped: 0, created: [] };
    const header = rows[0].map((h) => h.trim().toLowerCase());
    const col = (...names) => header.findIndex((h) => names.includes(h));
    const idx = {
      date: col('date', 'transaction date', 'posted date', 'posting date'),
      desc: col('description', 'desc', 'memo', 'payee', 'name'),
      type: col('type'),
      amount: col('amount'),
      debit: col('debit', 'withdrawal', 'withdrawals'),
      credit: col('credit', 'deposit', 'deposits'),
      category: col('category'),
      account: col('account'),
      to: col('to account'),
      member: col('member', 'person'),
      notes: col('notes', 'note'),
    };
    if (idx.date < 0 || (idx.amount < 0 && idx.debit < 0 && idx.credit < 0)) {
      throw new Error('CSV needs a "Date" column and an "Amount" (or Debit/Credit) column.');
    }
    const created = [];
    const findOrCreate = (list, nameValue, make) => {
      const n = (nameValue || '').trim();
      if (!n) return '';
      let item = list.find((x) => x.name.toLowerCase() === n.toLowerCase());
      if (!item) { item = make(n); list.push(item); created.push(n); }
      return item.id;
    };
    let added = 0, skipped = 0;
    for (const r of rows.slice(1)) {
      const get = (i) => (i >= 0 && r[i] != null ? r[i].trim() : '');
      const date = normalizeDate(get(idx.date));
      let amount;
      if (idx.amount >= 0 && get(idx.amount) !== '') amount = parseMoney(get(idx.amount));
      else {
        const debit = get(idx.debit) ? Math.abs(parseMoney(get(idx.debit))) : 0;
        const credit = get(idx.credit) ? Math.abs(parseMoney(get(idx.credit))) : 0;
        amount = credit - debit;
      }
      if (!date || !Number.isFinite(amount) || amount === 0) { skipped++; continue; }
      let type = get(idx.type).toLowerCase();
      if (!TX_TYPES.includes(type)) type = amount < 0 ? 'expense' : 'income';
      const kind = type === 'income' ? 'income' : 'expense';
      const accountId = findOrCreate(state.accounts, get(idx.account),
        (n) => ({ id: uid(), name: n, type: 'checking', opening: 0 })) || defaults.accountId || '';
      state.transactions.push({
        id: uid(), date, desc: get(idx.desc), amount: Math.abs(amount), type,
        categoryId: type === 'transfer' ? '' : findOrCreate(state.categories, get(idx.category),
          (n) => ({ id: uid(), name: n, kind, budget: 0 })),
        accountId,
        toAccountId: type === 'transfer' ? findOrCreate(state.accounts, get(idx.to),
          (n) => ({ id: uid(), name: n, type: 'checking', opening: 0 })) : '',
        memberId: findOrCreate(state.members, get(idx.member), (n) => ({ id: uid(), name: n })) || defaults.memberId || '',
        notes: get(idx.notes),
      });
      added++;
    }
    return { added, skipped, created };
  }

  // ---------- Sample data ----------

  function sampleState(refDate) {
    const s = defaultState();
    refDate = refDate || today();
    const cat = (n) => s.categories.find((c) => c.name === n).id;
    s.members = [{ id: uid(), name: 'Alex' }, { id: uid(), name: 'Sam' }, { id: uid(), name: 'Shared' }];
    const [alex, sam, shared] = s.members.map((m) => m.id);
    s.accounts = [
      { id: uid(), name: 'Joint Checking', type: 'checking', opening: 420000 },
      { id: uid(), name: 'Emergency Savings', type: 'savings', opening: 1200000 },
      { id: uid(), name: 'Family Credit Card', type: 'credit', opening: 0 },
    ];
    const [checking, savings, credit] = s.accounts.map((a) => a.id);
    const budgets = { Housing: 210000, Utilities: 32000, Groceries: 90000, 'Dining Out': 30000,
      Transportation: 40000, Health: 15000, Insurance: 28000, 'Kids & Education': 25000,
      Shopping: 30000, Entertainment: 15000, Subscriptions: 6000 };
    for (const c of s.categories) if (budgets[c.name]) c.budget = budgets[c.name];

    const endMonth = monthKey(refDate);
    const dayLimit = Number(refDate.slice(8, 10));
    let seed = 7;
    const rand = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    const add = (date, desc, amount, type, category, account, member, extra) => {
      s.transactions.push({ id: uid(), date, desc, amount, type, categoryId: category ? cat(category) : '',
        accountId: account, toAccountId: (extra && extra.to) || '', memberId: member, notes: '' });
    };
    for (let i = 5; i >= 0; i--) {
      const month = shiftMonth(endMonth, -i);
      const maxDay = i === 0 ? dayLimit : daysInMonth(+month.slice(0, 4), +month.slice(5, 7));
      const d = (day) => (day <= maxDay ? month + '-' + pad(day) : null);
      const when = (day, fn) => { const ds = d(day); if (ds) fn(ds); };
      when(1, (ds) => add(ds, 'Paycheck', 385000, 'income', 'Salary', checking, alex));
      when(15, (ds) => add(ds, 'Paycheck', 310000, 'income', 'Salary', checking, sam));
      when(1, (ds) => add(ds, 'Mortgage', 195000, 'expense', 'Housing', checking, shared));
      when(5, (ds) => add(ds, 'Electric bill', 9000 + Math.round(rand() * 6000), 'expense', 'Utilities', checking, shared));
      when(8, (ds) => add(ds, 'Internet', 7000, 'expense', 'Utilities', checking, shared));
      when(10, (ds) => add(ds, 'Car insurance', 14000, 'expense', 'Insurance', checking, shared));
      when(12, (ds) => add(ds, 'Streaming services', 3200, 'expense', 'Subscriptions', credit, shared));
      when(16, (ds) => add(ds, 'Transfer to savings', 50000, 'transfer', null, checking, shared, { to: savings }));
      when(20, (ds) => add(ds, 'Swim lessons', 12000, 'expense', 'Kids & Education', credit, sam));
      when(25, (ds) => add(ds, 'Credit card payment', 60000, 'transfer', null, checking, shared, { to: credit }));
      for (const day of [3, 10, 17, 24]) {
        when(day, (ds) => add(ds, 'Grocery store', 16000 + Math.round(rand() * 8000), 'expense', 'Groceries', credit, rand() > 0.5 ? alex : sam));
      }
      for (const day of [6, 19]) {
        when(day, (ds) => add(ds, 'Gas station', 4500 + Math.round(rand() * 2500), 'expense', 'Transportation', credit, rand() > 0.5 ? alex : sam));
      }
      for (const day of [9, 22, 28]) {
        when(day, (ds) => add(ds, 'Restaurant', 3500 + Math.round(rand() * 6000), 'expense', 'Dining Out', credit, shared));
      }
      when(14, (ds) => add(ds, 'Online order', 4000 + Math.round(rand() * 12000), 'expense', 'Shopping', credit, rand() > 0.5 ? alex : sam));
      when(27, (ds) => add(ds, 'Movie night', 4800, 'expense', 'Entertainment', credit, shared));
    }
    const nextOn = (day) => {
      let ds = endMonth + '-' + pad(day);
      return ds <= refDate ? addMonths(ds, 1) : ds;
    };
    s.bills = [
      { id: uid(), name: 'Mortgage', amount: 195000, categoryId: cat('Housing'), accountId: checking, memberId: shared, frequency: 'monthly', nextDue: nextOn(1) },
      { id: uid(), name: 'Electric bill', amount: 12000, categoryId: cat('Utilities'), accountId: checking, memberId: shared, frequency: 'monthly', nextDue: nextOn(5) },
      { id: uid(), name: 'Internet', amount: 7000, categoryId: cat('Utilities'), accountId: checking, memberId: shared, frequency: 'monthly', nextDue: nextOn(8) },
      { id: uid(), name: 'Car insurance', amount: 14000, categoryId: cat('Insurance'), accountId: checking, memberId: shared, frequency: 'monthly', nextDue: nextOn(10) },
      { id: uid(), name: 'Streaming services', amount: 3200, categoryId: cat('Subscriptions'), accountId: credit, memberId: shared, frequency: 'monthly', nextDue: nextOn(12) },
    ];
    s.goals = [
      { id: uid(), name: 'Summer vacation', target: 500000, saved: 185000, deadline: addMonths(refDate, 8) },
      { id: uid(), name: 'College fund', target: 4000000, saved: 960000, deadline: addMonths(refDate, 120) },
    ];
    return s;
  }

  const api = {
    SCHEMA_VERSION, ACCOUNT_TYPES, TX_TYPES, FREQUENCIES,
    uid, parseMoney, formatMoney, centsToInput,
    toISODate, parseISODate, today, monthKey, shiftMonth, monthLabel, addMonths, addDays, daysBetween,
    advanceDate, monthlyEquivalent,
    defaultState, normalizeState, sampleState,
    txEffect, accountBalance, netWorth, monthSummary, spendingByMember, monthlyTrend, budgetStatus,
    upcomingBills, goalMonthlyNeeded,
    parseCSV, transactionsToCSV, importTransactionsCSV, normalizeDate,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Core = api;
})(typeof window !== 'undefined' ? window : globalThis);
