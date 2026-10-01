/* Family Finances — UI layer. Depends on window.Core (js/core.js). */
(function () {
  'use strict';

  const C = window.Core;
  const STORAGE_KEY = 'family-finances';
  const VIEWS = ['dashboard', 'transactions', 'budgets', 'bills', 'goals', 'accounts', 'settings'];

  // ---------- State & persistence ----------

  let state;
  let storageOK = true;

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      state = raw ? C.normalizeState(JSON.parse(raw)) : C.defaultState();
    } catch (e) {
      storageOK = false;
      state = C.defaultState();
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      storageOK = true;
    } catch (e) {
      storageOK = false;
      toast('Could not save — your browser storage is unavailable or full. Export a backup!');
    }
  }

  function commit(message) {
    save();
    render();
    if (message) toast(message);
  }

  const ui = {
    view: 'dashboard',
    month: C.monthKey(C.today()),
    tx: { month: C.monthKey(C.today()), q: '', type: '', categoryId: '', memberId: '', accountId: '' },
  };

  // ---------- Helpers ----------

  const $ = (sel, root) => (root || document).querySelector(sel);
  const viewEl = $('#view');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const money = (c) => C.formatMoney(c, state.currency);
  const byId = (list, id) => list.find((x) => x.id === id);
  const nameOf = (list, id, fallback) => (byId(list, id) || {}).name || fallback || '—';
  const sortByName = (list) => [...list].sort((a, b) => a.name.localeCompare(b.name));

  function options(list, selected, blank) {
    let html = blank != null ? `<option value="">${esc(blank)}</option>` : '';
    for (const item of list) {
      html += `<option value="${esc(item.id)}"${item.id === selected ? ' selected' : ''}>${esc(item.name)}</option>`;
    }
    return html;
  }

  function prettyDate(ds) {
    return C.parseISODate(ds).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
  }

  function download(filename, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function pickFile(accept) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = accept;
      input.onchange = () => {
        const file = input.files && input.files[0];
        if (!file) return resolve(null);
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => resolve(null);
        reader.readAsText(file);
      };
      input.click();
    });
  }

  function applyTheme() {
    const root = document.documentElement;
    if (state.theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', state.theme);
  }

  function monthPicker(month, action) {
    return `<div class="month-picker">
      <button class="btn small" type="button" data-action="${action}" data-delta="-1" aria-label="Previous month">‹</button>
      <strong>${esc(C.monthLabel(month))}</strong>
      <button class="btn small" type="button" data-action="${action}" data-delta="1" aria-label="Next month">›</button>
    </div>`;
  }

  function progressBar(value, max, cls) {
    const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
    return `<div class="track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}">
      <div class="fill ${cls || ''}" style="width:${pct.toFixed(1)}%"></div></div>`;
  }

  const STATUS_TEXT = {
    ok: (left) => `<span class="ico">✓</span> On track · ${money(left)} left`,
    warning: (left) => `<span class="ico">!</span> Nearly there · ${money(left)} left`,
    over: (left) => `<span class="ico">✕</span> Over by ${money(-left)}`,
  };

  // ---------- Modal ----------

  const modal = $('#modal');
  let modalHandlers = {};

  function openModal({ title, body, onSave, onDelete, saveLabel }) {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = body;
    $('#modal-error').textContent = '';
    $('#modal-save').textContent = saveLabel || 'Save';
    $('#modal-delete').hidden = !onDelete;
    modalHandlers = { onSave, onDelete };
    modal.showModal();
    const first = $('#modal-body [autofocus]') || $('#modal-body input, #modal-body select');
    if (first) first.focus();
  }

  function closeModal() { modal.close(); modalHandlers = {}; }

  $('#modal-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!modalHandlers.onSave) return closeModal();
    const data = Object.fromEntries(new FormData(e.target).entries());
    const error = modalHandlers.onSave(data);
    if (error) { $('#modal-error').textContent = error; return; }
    closeModal();
  });
  $('#modal-cancel').addEventListener('click', closeModal);
  $('#modal-delete').addEventListener('click', () => {
    if (modalHandlers.onDelete && modalHandlers.onDelete() !== false) closeModal();
  });

  function readAmount(value, { allowZero, allowNegative } = {}) {
    const cents = C.parseMoney(value || '');
    if (!Number.isFinite(cents)) return { error: 'Please enter a valid amount, like 25 or 1,234.56.' };
    if (!allowNegative && cents < 0) return { error: 'Amount cannot be negative.' };
    if (!allowZero && cents === 0) return { error: 'Amount must be more than zero.' };
    return { cents };
  }

  // ---------- Forms ----------

  function transactionForm(tx, preset) {
    const isNew = !tx;
    tx = tx || Object.assign({
      date: C.today(), type: 'expense', amount: 0, desc: '', notes: '',
      accountId: state.accounts[0] && state.accounts[0].id, memberId: '', categoryId: '', toAccountId: '',
    }, preset);
    const catOptions = (kind) => options(sortByName(state.categories.filter((c) => c.kind === kind)), tx.categoryId, 'Uncategorized');
    const body = `
      <div class="seg" role="radiogroup" aria-label="Type">
        ${C.TX_TYPES.map((t) => `<label><input type="radio" name="type" value="${t}"${tx.type === t ? ' checked' : ''}><span>${cap(t)}</span></label>`).join('')}
      </div>
      <div class="field-row">
        <label class="field"><span>Amount</span><input name="amount" inputmode="decimal" autocomplete="off" required autofocus value="${esc(tx.amount ? C.centsToInput(tx.amount) : '')}" placeholder="0.00"></label>
        <label class="field"><span>Date</span><input name="date" type="date" required value="${esc(tx.date)}"></label>
      </div>
      <label class="field"><span>Description</span><input name="desc" maxlength="120" value="${esc(tx.desc)}" placeholder="e.g. Grocery store"></label>
      <div class="field-row">
        <label class="field" data-show="expense income"><span>Category</span>
          <select name="categoryId" data-expense="${esc(catOptions('expense'))}" data-income="${esc(catOptions('income'))}"></select></label>
        <label class="field"><span>Family member</span><select name="memberId">${options(state.members, tx.memberId, '—')}</select></label>
      </div>
      <div class="field-row">
        <label class="field"><span data-label-account>Account</span><select name="accountId">${options(state.accounts, tx.accountId)}</select></label>
        <label class="field" data-show="transfer"><span>To account</span><select name="toAccountId">${options(state.accounts, tx.toAccountId, 'Choose…')}</select></label>
      </div>
      <label class="field"><span>Notes</span><textarea name="notes" maxlength="500">${esc(tx.notes)}</textarea></label>`;

    openModal({
      title: isNew ? 'Add transaction' : 'Edit transaction',
      body,
      onSave(d) {
        const amt = readAmount(d.amount);
        if (amt.error) return amt.error;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) return 'Please choose a date.';
        if (!d.accountId) return 'Please add an account first (Accounts tab).';
        if (d.type === 'transfer') {
          if (!d.toAccountId) return 'Choose which account the money goes to.';
          if (d.toAccountId === d.accountId) return 'Transfer accounts must be different.';
        }
        const record = {
          id: tx.id || C.uid(), date: d.date, desc: d.desc.trim(), amount: amt.cents, type: d.type,
          categoryId: d.type === 'transfer' ? '' : d.categoryId, accountId: d.accountId,
          toAccountId: d.type === 'transfer' ? d.toAccountId : '', memberId: d.memberId, notes: d.notes.trim(),
        };
        if (isNew) state.transactions.push(record);
        else Object.assign(byId(state.transactions, tx.id), record);
        commit(isNew ? 'Transaction added' : 'Transaction updated');
      },
      onDelete: isNew ? null : () => {
        if (!confirm('Delete this transaction?')) return false;
        state.transactions = state.transactions.filter((t) => t.id !== tx.id);
        commit('Transaction deleted');
      },
    });

    // Show/hide fields by type and swap category options.
    const form = $('#modal-form');
    const sync = () => {
      const type = form.querySelector('[name=type]:checked').value;
      form.querySelectorAll('[data-show]').forEach((el) => { el.hidden = !el.dataset.show.split(' ').includes(type); });
      const sel = form.querySelector('[name=categoryId]');
      if (type !== 'transfer' && sel.dataset.kind !== type) {
        const prev = sel.value;
        sel.innerHTML = sel.dataset[type];
        sel.dataset.kind = type;
        if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
      }
      form.querySelector('[data-label-account]').textContent = type === 'transfer' ? 'From account' : 'Account';
    };
    form.querySelectorAll('[name=type]').forEach((r) => r.addEventListener('change', sync));
    sync();
  }

  function accountForm(acct) {
    const isNew = !acct;
    acct = acct || { name: '', type: 'checking', opening: 0 };
    openModal({
      title: isNew ? 'Add account' : 'Edit account',
      body: `
        <label class="field"><span>Name</span><input name="name" required maxlength="60" autofocus value="${esc(acct.name)}" placeholder="e.g. Joint Checking"></label>
        <div class="field-row">
          <label class="field"><span>Type</span><select name="type">${C.ACCOUNT_TYPES.map((t) => `<option value="${t}"${t === acct.type ? ' selected' : ''}>${cap(t)}</option>`).join('')}</select></label>
          <label class="field"><span>Starting balance</span><input name="opening" inputmode="decimal" value="${esc(C.centsToInput(acct.opening))}"></label>
        </div>
        <p class="muted small">Starting balance is what the account held before the first transaction you record here. For credit cards, enter what you owe as a negative number.</p>`,
      onSave(d) {
        if (!d.name.trim()) return 'Please enter a name.';
        const amt = readAmount(d.opening || '0', { allowZero: true, allowNegative: true });
        if (amt.error) return amt.error;
        const rec = { name: d.name.trim(), type: d.type, opening: amt.cents };
        if (isNew) state.accounts.push({ id: C.uid(), ...rec });
        else Object.assign(acct, rec);
        commit(isNew ? 'Account added' : 'Account updated');
      },
      onDelete: isNew ? null : () => {
        const used = state.transactions.some((t) => t.accountId === acct.id || t.toAccountId === acct.id);
        if (used) { alert('This account has transactions. Delete or move those first.'); return false; }
        if (state.accounts.length === 1) { alert('You need at least one account.'); return false; }
        if (!confirm(`Delete account "${acct.name}"?`)) return false;
        state.accounts = state.accounts.filter((a) => a.id !== acct.id);
        state.bills.forEach((b) => { if (b.accountId === acct.id) b.accountId = ''; });
        commit('Account deleted');
      },
    });
  }

  function categoryForm(cat, kind) {
    const isNew = !cat;
    cat = cat || { name: '', kind: kind || 'expense', budget: 0 };
    openModal({
      title: isNew ? 'Add category' : `Edit “${cat.name}”`,
      body: `
        <label class="field"><span>Name</span><input name="name" required maxlength="60" autofocus value="${esc(cat.name)}"></label>
        <div class="field-row">
          <label class="field"><span>Kind</span><select name="kind">
            <option value="expense"${cat.kind === 'expense' ? ' selected' : ''}>Expense</option>
            <option value="income"${cat.kind === 'income' ? ' selected' : ''}>Income</option></select></label>
          <label class="field"><span>Monthly budget</span><input name="budget" inputmode="decimal" value="${esc(cat.budget ? C.centsToInput(cat.budget) : '')}" placeholder="No budget"></label>
        </div>
        <p class="muted small">Budgets apply to expense categories and reset every month.</p>`,
      onSave(d) {
        if (!d.name.trim()) return 'Please enter a name.';
        const dup = state.categories.find((c) => c.id !== cat.id && c.name.toLowerCase() === d.name.trim().toLowerCase());
        if (dup) return 'A category with that name already exists.';
        const amt = readAmount(d.budget || '0', { allowZero: true });
        if (amt.error) return amt.error;
        const rec = { name: d.name.trim(), kind: d.kind, budget: d.kind === 'expense' ? amt.cents : 0 };
        if (isNew) state.categories.push({ id: C.uid(), ...rec });
        else Object.assign(cat, rec);
        commit(isNew ? 'Category added' : 'Category updated');
      },
      onDelete: isNew ? null : () => {
        const n = state.transactions.filter((t) => t.categoryId === cat.id).length;
        if (!confirm(`Delete category "${cat.name}"?${n ? ` ${n} transaction(s) will become Uncategorized.` : ''}`)) return false;
        state.categories = state.categories.filter((c) => c.id !== cat.id);
        state.transactions.forEach((t) => { if (t.categoryId === cat.id) t.categoryId = ''; });
        state.bills.forEach((b) => { if (b.categoryId === cat.id) b.categoryId = ''; });
        commit('Category deleted');
      },
    });
  }

  function memberForm(member) {
    const isNew = !member;
    member = member || { name: '' };
    openModal({
      title: isNew ? 'Add family member' : 'Edit family member',
      body: `<label class="field"><span>Name</span><input name="name" required maxlength="40" autofocus value="${esc(member.name)}"></label>`,
      onSave(d) {
        if (!d.name.trim()) return 'Please enter a name.';
        if (isNew) state.members.push({ id: C.uid(), name: d.name.trim() });
        else member.name = d.name.trim();
        commit(isNew ? 'Family member added' : 'Updated');
      },
      onDelete: isNew ? null : () => {
        if (!confirm(`Remove ${member.name}? Their transactions will be kept but unassigned.`)) return false;
        state.members = state.members.filter((m) => m.id !== member.id);
        state.transactions.forEach((t) => { if (t.memberId === member.id) t.memberId = ''; });
        state.bills.forEach((b) => { if (b.memberId === member.id) b.memberId = ''; });
        commit('Family member removed');
      },
    });
  }

  function billForm(bill) {
    const isNew = !bill;
    bill = bill || { name: '', amount: 0, frequency: 'monthly', nextDue: C.today(), categoryId: '', accountId: state.accounts[0] && state.accounts[0].id, memberId: '' };
    openModal({
      title: isNew ? 'Add recurring bill' : 'Edit bill',
      body: `
        <label class="field"><span>Name</span><input name="name" required maxlength="60" autofocus value="${esc(bill.name)}" placeholder="e.g. Rent, Phone, Daycare"></label>
        <div class="field-row">
          <label class="field"><span>Amount</span><input name="amount" inputmode="decimal" required value="${esc(bill.amount ? C.centsToInput(bill.amount) : '')}" placeholder="0.00"></label>
          <label class="field"><span>Repeats</span><select name="frequency">${C.FREQUENCIES.map((f) => `<option value="${f}"${f === bill.frequency ? ' selected' : ''}>${cap(f)}</option>`).join('')}</select></label>
        </div>
        <div class="field-row">
          <label class="field"><span>Next due date</span><input name="nextDue" type="date" required value="${esc(bill.nextDue)}"></label>
          <label class="field"><span>Category</span><select name="categoryId">${options(sortByName(state.categories.filter((c) => c.kind === 'expense')), bill.categoryId, 'Uncategorized')}</select></label>
        </div>
        <div class="field-row">
          <label class="field"><span>Paid from</span><select name="accountId">${options(state.accounts, bill.accountId)}</select></label>
          <label class="field"><span>Family member</span><select name="memberId">${options(state.members, bill.memberId, '—')}</select></label>
        </div>`,
      onSave(d) {
        if (!d.name.trim()) return 'Please enter a name.';
        const amt = readAmount(d.amount);
        if (amt.error) return amt.error;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d.nextDue)) return 'Please choose the next due date.';
        const rec = { name: d.name.trim(), amount: amt.cents, frequency: d.frequency, nextDue: d.nextDue,
          categoryId: d.categoryId, accountId: d.accountId, memberId: d.memberId };
        if (isNew) state.bills.push({ id: C.uid(), ...rec });
        else Object.assign(bill, rec);
        commit(isNew ? 'Bill added' : 'Bill updated');
      },
      onDelete: isNew ? null : () => {
        if (!confirm(`Delete bill "${bill.name}"?`)) return false;
        state.bills = state.bills.filter((b) => b.id !== bill.id);
        commit('Bill deleted');
      },
    });
  }

  function payBill(bill) {
    openModal({
      title: `Pay “${bill.name}”`,
      saveLabel: 'Record payment',
      body: `
        <div class="field-row">
          <label class="field"><span>Amount paid</span><input name="amount" inputmode="decimal" autofocus value="${esc(C.centsToInput(bill.amount))}"></label>
          <label class="field"><span>Date paid</span><input name="date" type="date" value="${esc(C.today())}"></label>
        </div>
        <p class="muted small">This records an expense and moves the due date to ${esc(prettyDate(C.advanceDate(bill.nextDue, bill.frequency)))}.</p>`,
      onSave(d) {
        const amt = readAmount(d.amount);
        if (amt.error) return amt.error;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) return 'Please choose a date.';
        const accountId = byId(state.accounts, bill.accountId) ? bill.accountId : state.accounts[0].id;
        state.transactions.push({ id: C.uid(), date: d.date, desc: bill.name, amount: amt.cents, type: 'expense',
          categoryId: bill.categoryId, accountId, toAccountId: '', memberId: bill.memberId, notes: 'Recurring bill' });
        bill.nextDue = C.advanceDate(bill.nextDue, bill.frequency);
        commit(`Paid ${bill.name}`);
      },
    });
  }

  function goalForm(goal) {
    const isNew = !goal;
    goal = goal || { name: '', target: 0, saved: 0, deadline: '' };
    openModal({
      title: isNew ? 'Add savings goal' : 'Edit goal',
      body: `
        <label class="field"><span>Goal</span><input name="name" required maxlength="60" autofocus value="${esc(goal.name)}" placeholder="e.g. Family vacation"></label>
        <div class="field-row">
          <label class="field"><span>Target amount</span><input name="target" inputmode="decimal" required value="${esc(goal.target ? C.centsToInput(goal.target) : '')}"></label>
          <label class="field"><span>Saved so far</span><input name="saved" inputmode="decimal" value="${esc(C.centsToInput(goal.saved))}"></label>
        </div>
        <label class="field"><span>Target date (optional)</span><input name="deadline" type="date" value="${esc(goal.deadline)}"></label>`,
      onSave(d) {
        if (!d.name.trim()) return 'Please name your goal.';
        const target = readAmount(d.target);
        if (target.error) return target.error;
        const saved = readAmount(d.saved || '0', { allowZero: true });
        if (saved.error) return saved.error;
        const rec = { name: d.name.trim(), target: target.cents, saved: saved.cents, deadline: d.deadline || '' };
        if (isNew) state.goals.push({ id: C.uid(), ...rec });
        else Object.assign(goal, rec);
        commit(isNew ? 'Goal added' : 'Goal updated');
      },
      onDelete: isNew ? null : () => {
        if (!confirm(`Delete goal "${goal.name}"?`)) return false;
        state.goals = state.goals.filter((g) => g.id !== goal.id);
        commit('Goal deleted');
      },
    });
  }

  function contributeForm(goal) {
    openModal({
      title: `Add to “${goal.name}”`,
      saveLabel: 'Add',
      body: `<label class="field"><span>Amount</span><input name="amount" inputmode="decimal" autofocus placeholder="0.00"></label>
        <p class="muted small">Use a negative number to take money out.</p>`,
      onSave(d) {
        const amt = readAmount(d.amount, { allowNegative: true });
        if (amt.error) return amt.error;
        goal.saved = Math.max(0, goal.saved + amt.cents);
        commit(goal.saved >= goal.target ? `🎉 “${goal.name}” is fully funded!` : 'Goal updated');
      },
    });
  }

  // ---------- Charts ----------

  // Drawn at the container's real pixel width so text stays a readable size.
  function trendChart(trend, width) {
    const W = Math.max(260, Math.round(width || 560)), H = 220, padL = 48, padR = 4, padT = 10, padB = 26;
    const max = Math.max(1, ...trend.map((t) => Math.max(t.income, t.expense)));
    const step = niceStep(max / 4);
    const top = Math.ceil(max / step) * step;
    const y = (v) => padT + (H - padT - padB) * (1 - v / top);
    const groupW = (W - padL - padR) / trend.length;
    const barW = Math.min(22, (groupW - 14) / 2);
    let svg = '';
    for (let v = 0; v <= top; v += step) {
      svg += `<line class="${v === 0 ? 'baseline' : 'grid-line'}" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/>`;
      svg += `<text x="${padL - 8}" y="${y(v) + 4}" text-anchor="end">${esc(shortMoney(v))}</text>`;
    }
    trend.forEach((t, i) => {
      const cx = padL + groupW * i + groupW / 2;
      svg += `<rect class="hit" data-i="${i}" x="${cx - groupW / 2}" y="${padT}" width="${groupW}" height="${H - padT - padB}" rx="6"/>`;
      svg += barPath(cx - barW - 1, y(t.income), barW, y(0), 'income');
      svg += barPath(cx + 1, y(t.expense), barW, y(0), 'spend');
      svg += `<text x="${cx}" y="${H - 8}" text-anchor="middle">${esc(C.monthLabel(t.month, 'short'))}</text>`;
    });
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Income and spending for the last ${trend.length} months">${svg}</svg>`;
  }

  // Bar with rounded top (data end) and a square base on the baseline.
  function barPath(x, yTop, w, yBase, cls) {
    const h = yBase - yTop;
    if (h <= 0.5) return '';
    const r = Math.min(4, h, w / 2);
    return `<path class="${cls}" pointer-events="none" d="M${x},${yBase} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + w - r} Q${x + w},${yTop} ${x + w},${yTop + r} V${yBase} Z"/>`;
  }

  function niceStep(raw) {
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
  }

  function shortMoney(cents) {
    const v = cents / 100;
    const sym = C.formatMoney(0, state.currency).replace(/[\d.,\s]/g, '');
    if (v >= 1e6) return sym + (v / 1e6).toFixed(v % 1e6 ? 1 : 0) + 'M';
    if (v >= 1e3) return sym + (v / 1e3).toFixed(v % 1e3 ? 1 : 0) + 'k';
    return sym + Math.round(v);
  }

  let tooltipData = null;
  let drawTrend = null;
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (drawTrend) drawTrend(); }, 100);
  });
  const tooltip = $('#tooltip');
  viewEl.addEventListener('mousemove', (e) => {
    const hit = e.target.closest && e.target.closest('.hit');
    if (!hit || !tooltipData) { tooltip.classList.remove('show'); return; }
    const t = tooltipData[+hit.dataset.i];
    tooltip.innerHTML = `<div class="t-title">${esc(C.monthLabel(t.month))}</div>
      <div class="t-row"><i style="background:var(--series-income)"></i>Income<b>${esc(money(t.income))}</b></div>
      <div class="t-row"><i style="background:var(--series-spend)"></i>Spending<b>${esc(money(t.expense))}</b></div>
      <div class="t-row">Net<b class="${t.net >= 0 ? 'pos' : 'neg'}">${esc(money(t.net))}</b></div>`;
    const rect = tooltip.getBoundingClientRect();
    let x = e.clientX + 14, yPos = e.clientY + 14;
    if (x + rect.width > window.innerWidth - 8) x = e.clientX - rect.width - 14;
    if (yPos + rect.height > window.innerHeight - 8) yPos = e.clientY - rect.height - 14;
    tooltip.style.left = x + 'px'; tooltip.style.top = yPos + 'px';
    tooltip.classList.add('show');
  });
  viewEl.addEventListener('mouseleave', () => tooltip.classList.remove('show'));

  // ---------- Views ----------

  function renderDashboard() {
    const month = ui.month;
    const sum = C.monthSummary(state, month);
    const prev = C.monthSummary(state, C.shiftMonth(month, -1));
    const worth = C.netWorth(state);
    const trend = C.monthlyTrend(state, month, 6);
    tooltipData = trend;
    const totalBudget = state.categories.reduce((a, c) => a + (c.kind === 'expense' ? c.budget : 0), 0);

    const empty = !state.transactions.length;
    const delta = (cur, before, upIsGood) => {
      if (!before) return '<div class="sub">—</div>';
      const pct = Math.round(((cur - before) / before) * 100);
      const good = upIsGood ? pct >= 0 : pct <= 0;
      return `<div class="sub"><span class="${good ? 'pos' : 'neg'}">${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct)}%</span> vs last month</div>`;
    };

    const spendRows = Object.entries(sum.byCategory)
      .map(([id, amt]) => ({ id, amt, cat: byId(state.categories, id) }))
      .sort((a, b) => b.amt - a.amt);
    const maxSpend = spendRows.length ? spendRows[0].amt : 0;

    const bills = C.upcomingBills(state, C.today(), 14);
    drawTrend = () => {
      const el = $('#trend-chart');
      if (el) el.innerHTML = trendChart(trend, el.clientWidth);
    };
    const byMember = C.spendingByMember(state, month);
    const memberRows = Object.entries(byMember).sort((a, b) => b[1] - a[1]);

    viewEl.innerHTML = `
      <div class="view-head"><h1>Overview</h1>${monthPicker(month, 'month')}</div>
      ${empty ? `<div class="notice">Welcome! Start by adding your accounts and a few transactions, or
        <button class="btn link" type="button" data-action="load-sample">load sample data</button> to look around first.</div>` : ''}
      ${!storageOK ? '<div class="notice">⚠ Your browser is blocking storage, so changes won’t be kept after you close this page. Use Settings → Export backup.</div>' : ''}
      <div class="grid cols-4">
        <div class="card stat"><div class="label">Income</div><div class="value">${money(sum.income)}</div>${delta(sum.income, prev.income, true)}</div>
        <div class="card stat"><div class="label">Spending</div><div class="value">${money(sum.expense)}</div>${delta(sum.expense, prev.expense, false)}</div>
        <div class="card stat"><div class="label">Left over</div><div class="value ${sum.net >= 0 ? 'pos' : 'neg'}">${money(sum.net)}</div>
          <div class="sub">${sum.income ? Math.round((sum.net / sum.income) * 100) + '% savings rate' : '—'}</div></div>
        <div class="card stat"><div class="label">Net worth</div><div class="value">${money(worth)}</div>
          <div class="sub">across ${state.accounts.length} account${state.accounts.length === 1 ? '' : 's'}</div></div>
      </div>

      <div class="grid cols-2 mt">
        <div class="card">
          <div class="card-head"><h2>Income vs spending</h2><span class="muted small">last 6 months</span></div>
          <div class="legend"><span><i style="background:var(--series-income)"></i>Income</span><span><i style="background:var(--series-spend)"></i>Spending</span></div>
          <div id="trend-chart" style="min-height:220px"></div>
          <details class="data-table"><summary>Show as table</summary>
            <table><thead><tr><th>Month</th><th class="num">Income</th><th class="num">Spending</th><th class="num">Net</th></tr></thead><tbody>
            ${trend.map((t) => `<tr><td>${esc(C.monthLabel(t.month))}</td><td class="num">${money(t.income)}</td><td class="num">${money(t.expense)}</td><td class="num ${t.net >= 0 ? 'pos' : 'neg'}">${money(t.net)}</td></tr>`).join('')}
            </tbody></table></details>
        </div>

        <div class="card">
          <div class="card-head"><h2>Spending by category</h2>
            <span class="muted small">${totalBudget ? `${money(sum.expense)} of ${money(totalBudget)} budget` : ''}</span></div>
          ${spendRows.length ? spendRows.slice(0, 8).map((r) => {
            const budget = r.cat ? r.cat.budget : 0;
            const status = C.budgetStatus(r.amt, budget);
            return `<div class="bar-row"><div class="bar-top"><span>${esc(r.cat ? r.cat.name : 'Uncategorized')}</span>
              <span class="amt">${money(r.amt)}${budget ? ` / ${money(budget)}` : ''}</span></div>
              ${budget ? progressBar(r.amt, budget, status) : progressBar(r.amt, maxSpend)}</div>`;
          }).join('') + (spendRows.length > 8 ? `<button class="btn link" type="button" data-nav="budgets">See all ${spendRows.length} categories →</button>` : '')
          : '<div class="empty">No spending recorded this month.</div>'}
        </div>

        <div class="card">
          <div class="card-head"><h2>Upcoming bills</h2><button class="btn link" type="button" data-nav="bills">All bills →</button></div>
          ${bills.length ? `<ul class="list">${bills.map(billRow).join('')}</ul>` : '<div class="empty">Nothing due in the next two weeks.</div>'}
        </div>

        <div class="card">
          <div class="card-head"><h2>Savings goals</h2><button class="btn link" type="button" data-nav="goals">All goals →</button></div>
          ${state.goals.length ? state.goals.slice(0, 4).map((g) => `<div class="bar-row"><div class="bar-top"><span>${esc(g.name)}</span>
            <span class="amt">${money(g.saved)} / ${money(g.target)}</span></div>${progressBar(g.saved, g.target)}</div>`).join('')
          : '<div class="empty">No goals yet. <br><button class="btn" type="button" data-action="add-goal">Add a goal</button></div>'}
        </div>

        ${memberRows.length > 1 ? `<div class="card">
          <div class="card-head"><h2>Spending by family member</h2></div>
          ${memberRows.map(([id, amt]) => `<div class="bar-row"><div class="bar-top"><span>${esc(nameOf(state.members, id, 'Unassigned'))}</span>
            <span class="amt">${money(amt)} · ${sum.expense ? Math.round((amt / sum.expense) * 100) : 0}%</span></div>${progressBar(amt, sum.expense)}</div>`).join('')}
        </div>` : ''}

        <div class="card">
          <div class="card-head"><h2>Recent transactions</h2><button class="btn link" type="button" data-nav="transactions">All →</button></div>
          ${txTable([...state.transactions].sort(txSort).slice(0, 6), true)}
        </div>
      </div>`;
  }

  function billRow(b) {
    const d = b.daysUntil != null ? b.daysUntil : C.daysBetween(C.today(), b.nextDue);
    const when = d < 0 ? `<span class="neg">Overdue ${-d} day${d === -1 ? '' : 's'}</span>`
      : d === 0 ? '<strong>Due today</strong>' : d === 1 ? 'Due tomorrow' : `Due ${esc(prettyDate(b.nextDue))}`;
    return `<li><div class="grow"><div>${esc(b.name)}</div><div class="meta">${when} · ${esc(cap(b.frequency))}</div></div>
      <strong class="num">${money(b.amount)}</strong>
      <button class="btn small" type="button" data-action="pay-bill" data-id="${esc(b.id)}">Pay</button></li>`;
  }

  const txSort = (a, b) => b.date.localeCompare(a.date) || (b.id > a.id ? 1 : -1);

  function txTable(list, compact) {
    if (!list.length) return '<div class="empty">No transactions to show.</div>';
    const rows = list.map((t) => {
      const sign = t.type === 'income' ? '+' : t.type === 'expense' ? '−' : '';
      const cls = t.type === 'income' ? 'pos' : '';
      const label = t.type === 'transfer'
        ? `${esc(nameOf(state.accounts, t.accountId))} → ${esc(nameOf(state.accounts, t.toAccountId))}`
        : esc(nameOf(state.categories, t.categoryId, 'Uncategorized'));
      return `<tr class="clickable" data-action="edit-tx" data-id="${esc(t.id)}" tabindex="0">
        <td class="muted" style="white-space:nowrap">${esc(C.parseISODate(t.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}</td>
        <td class="desc-cell"><div>${esc(t.desc || (t.type === 'transfer' ? 'Transfer' : '(no description)'))}</div>
          <div class="meta${compact ? '' : ' show-sm'}">${label}</div></td>
        ${compact ? '' : `<td class="hide-sm"><span class="chip">${label}</span></td>
          <td class="hide-sm">${esc(t.type === 'transfer' ? '' : nameOf(state.accounts, t.accountId))}</td>
          <td class="hide-sm">${esc(nameOf(state.members, t.memberId, ''))}</td>`}
        <td class="num ${cls}">${sign}${money(t.amount)}</td></tr>`;
    }).join('');
    const head = compact ? '' : `<thead><tr><th>Date</th><th>Description</th><th class="hide-sm">Category</th><th class="hide-sm">Account</th><th class="hide-sm">Member</th><th class="num">Amount</th></tr></thead>`;
    return `<div class="table-wrap"><table>${head}<tbody>${rows}</tbody></table></div>`;
  }

  function filteredTransactions() {
    const f = ui.tx;
    const q = f.q.trim().toLowerCase();
    return state.transactions.filter((t) => {
      if (f.month && C.monthKey(t.date) !== f.month) return false;
      if (f.type && t.type !== f.type) return false;
      if (f.categoryId && t.categoryId !== (f.categoryId === '__none' ? '' : f.categoryId)) return false;
      if (f.memberId && t.memberId !== f.memberId) return false;
      if (f.accountId && t.accountId !== f.accountId && t.toAccountId !== f.accountId) return false;
      if (q) {
        const hay = [t.desc, t.notes, nameOf(state.categories, t.categoryId, ''), C.centsToInput(t.amount)].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    }).sort(txSort);
  }

  function renderTransactions() {
    const f = ui.tx;
    const list = filteredTransactions();
    const income = list.filter((t) => t.type === 'income').reduce((a, t) => a + t.amount, 0);
    const expense = list.filter((t) => t.type === 'expense').reduce((a, t) => a + t.amount, 0);
    viewEl.innerHTML = `
      <div class="view-head"><h1>Transactions</h1>
        <div class="toolbar">
          <button class="btn" type="button" data-action="import-csv">Import CSV</button>
          <button class="btn" type="button" data-action="export-csv">Export CSV</button>
        </div></div>
      <div class="card">
        <div class="toolbar" style="margin-bottom:12px">
          ${f.month ? monthPicker(f.month, 'tx-month') : ''}
          <button class="btn small" type="button" data-action="tx-all">${f.month ? 'Show all dates' : 'Show one month'}</button>
          <input type="search" placeholder="Search…" aria-label="Search" data-filter="q" value="${esc(f.q)}" style="flex:1;min-width:140px">
          <select data-filter="type" aria-label="Type"><option value="">All types</option>${C.TX_TYPES.map((t) => `<option value="${t}"${f.type === t ? ' selected' : ''}>${cap(t)}</option>`).join('')}</select>
          <select data-filter="categoryId" aria-label="Category">${options(sortByName(state.categories), f.categoryId, 'All categories')}<option value="__none"${f.categoryId === '__none' ? ' selected' : ''}>Uncategorized</option></select>
          <select data-filter="memberId" aria-label="Family member">${options(state.members, f.memberId, 'Everyone')}</select>
          <select data-filter="accountId" aria-label="Account">${options(state.accounts, f.accountId, 'All accounts')}</select>
        </div>
        <p class="small muted" style="margin:0 0 8px">${list.length} transaction${list.length === 1 ? '' : 's'} ·
          <span class="pos">+${money(income)}</span> in · −${money(expense)} out</p>
        ${txTable(list, false)}
      </div>
      <p class="muted small">Tip: import a CSV exported from your bank. It needs Date and Amount (or Debit/Credit) columns; negative amounts count as spending.</p>`;
  }

  function renderBudgets() {
    const month = ui.month;
    const sum = C.monthSummary(state, month);
    const cats = sortByName(state.categories.filter((c) => c.kind === 'expense'));
    const budgeted = cats.filter((c) => c.budget > 0);
    const unbudgeted = cats.filter((c) => !c.budget);
    const totalBudget = budgeted.reduce((a, c) => a + c.budget, 0);
    const spentInBudgeted = budgeted.reduce((a, c) => a + (sum.byCategory[c.id] || 0), 0);
    const uncategorized = sum.byCategory[''] || 0;
    // Typical income = average of the previous 3 months that had any income (the current month may be incomplete).
    const pastIncome = [1, 2, 3].map((i) => C.monthSummary(state, C.shiftMonth(month, -i)).income).filter((v) => v > 0);
    const typicalIncome = pastIncome.length ? Math.round(pastIncome.reduce((a, v) => a + v, 0) / pastIncome.length) : sum.income;

    const row = (c) => {
      const spent = sum.byCategory[c.id] || 0;
      const status = C.budgetStatus(spent, c.budget);
      const left = c.budget - spent;
      return `<div class="bar-row">
        <div class="bar-top"><button class="btn link" style="padding:0" type="button" data-action="edit-cat" data-id="${esc(c.id)}">${esc(c.name)}</button>
          <span class="amt">${money(spent)} of ${money(c.budget)}</span></div>
        ${progressBar(spent, c.budget, status)}
        <div class="status ${status}">${STATUS_TEXT[status](left)}</div></div>`;
    };

    viewEl.innerHTML = `
      <div class="view-head"><h1>Budgets</h1>
        <div class="toolbar">${monthPicker(month, 'month')}<button class="btn primary" type="button" data-action="add-cat">+ Category</button></div></div>
      <div class="grid cols-4">
        <div class="card stat"><div class="label">Monthly budget</div><div class="value">${money(totalBudget)}</div></div>
        <div class="card stat"><div class="label">Spent (budgeted)</div><div class="value">${money(spentInBudgeted)}</div></div>
        <div class="card stat"><div class="label">Remaining</div><div class="value ${totalBudget - spentInBudgeted >= 0 ? 'pos' : 'neg'}">${money(totalBudget - spentInBudgeted)}</div></div>
        <div class="card stat"><div class="label">Typical monthly income</div><div class="value">${money(typicalIncome)}</div>
          <div class="sub">${typicalIncome && totalBudget > typicalIncome ? '<span class="neg">Budget is more than income</span>' : pastIncome.length ? 'avg. of recent months' : '&nbsp;'}</div></div>
      </div>
      <div class="grid cols-2 mt">
        <div class="card"><h2>Budgeted categories</h2>
          ${budgeted.length ? budgeted.map(row).join('') : '<div class="empty">No budgets yet. Click a category on the right to set a monthly limit.</div>'}</div>
        <div class="card"><h2>No budget set</h2>
          <ul class="list">${unbudgeted.map((c) => `<li><span class="grow">${esc(c.name)}</span>
            <span class="muted num">${money(sum.byCategory[c.id] || 0)} spent</span>
            <button class="btn small" type="button" data-action="edit-cat" data-id="${esc(c.id)}">Set budget</button></li>`).join('')}
            ${uncategorized ? `<li><span class="grow">Uncategorized</span><span class="muted num">${money(uncategorized)} spent</span></li>` : ''}
          </ul>${!unbudgeted.length && !uncategorized ? '<div class="empty">Every category has a budget. 👏</div>' : ''}</div>
      </div>`;
  }

  function renderBills() {
    const bills = [...state.bills].sort((a, b) => a.nextDue.localeCompare(b.nextDue));
    const monthly = bills.reduce((a, b) => a + C.monthlyEquivalent(b.amount, b.frequency), 0);
    viewEl.innerHTML = `
      <div class="view-head"><h1>Recurring bills</h1><button class="btn primary" type="button" data-action="add-bill">+ Bill</button></div>
      <div class="grid cols-4">
        <div class="card stat"><div class="label">Bills tracked</div><div class="value">${bills.length}</div></div>
        <div class="card stat"><div class="label">Per month (approx.)</div><div class="value">${money(monthly)}</div></div>
        <div class="card stat"><div class="label">Per year (approx.)</div><div class="value">${money(monthly * 12)}</div></div>
      </div>
      <div class="card mt">
        ${bills.length ? `<ul class="list">${bills.map((b) => billRow(b).replace('</li>',
          `<button class="btn small" type="button" data-action="edit-bill" data-id="${esc(b.id)}">Edit</button></li>`)).join('')}</ul>`
          : '<div class="empty">Add the bills you pay regularly — rent, utilities, insurance, subscriptions — and you’ll see what’s due next.</div>'}
      </div>`;
  }

  function renderGoals() {
    const now = C.today();
    viewEl.innerHTML = `
      <div class="view-head"><h1>Savings goals</h1><button class="btn primary" type="button" data-action="add-goal">+ Goal</button></div>
      ${state.goals.length ? `<div class="grid cols-2">${state.goals.map((g) => {
        const pct = g.target ? Math.min(100, Math.round((g.saved / g.target) * 100)) : 0;
        const need = C.goalMonthlyNeeded(g, now);
        const done = g.saved >= g.target;
        return `<div class="card">
          <div class="card-head"><h2>${esc(g.name)}</h2><span class="muted small">${pct}%</span></div>
          <div class="stat"><div class="value">${money(g.saved)}</div><div class="sub">of ${money(g.target)}${g.deadline ? ` by ${esc(prettyDate(g.deadline))}` : ''}</div></div>
          <div style="margin:12px 0">${progressBar(g.saved, g.target, done ? 'ok' : '')}</div>
          <p class="small ${done ? 'pos' : 'muted'}">${done ? '✓ Goal reached!' : need != null ? `Save about ${money(need)}/month to stay on track.` : `${money(g.target - g.saved)} to go.`}</p>
          <div class="toolbar"><button class="btn small primary" type="button" data-action="contribute" data-id="${esc(g.id)}">Add money</button>
            <button class="btn small" type="button" data-action="edit-goal" data-id="${esc(g.id)}">Edit</button></div>
        </div>`;
      }).join('')}</div>` : '<div class="card"><div class="empty">Saving for a vacation, a new car or college? Add a goal to track your progress.</div></div>'}`;
  }

  function renderAccounts() {
    const groups = C.ACCOUNT_TYPES.map((type) => ({ type, items: state.accounts.filter((a) => a.type === type) })).filter((g) => g.items.length);
    let assets = 0, debts = 0;
    for (const a of state.accounts) {
      const b = C.accountBalance(state, a.id);
      if (b >= 0) assets += b; else debts += b;
    }
    viewEl.innerHTML = `
      <div class="view-head"><h1>Accounts</h1><button class="btn primary" type="button" data-action="add-account">+ Account</button></div>
      <div class="grid cols-4">
        <div class="card stat"><div class="label">Assets</div><div class="value">${money(assets)}</div></div>
        <div class="card stat"><div class="label">Debts</div><div class="value ${debts ? 'neg' : ''}">${money(debts)}</div></div>
        <div class="card stat"><div class="label">Net worth</div><div class="value">${money(assets + debts)}</div></div>
      </div>
      ${groups.map((g) => `<div class="card mt"><h2>${cap(g.type)}</h2><ul class="list">${g.items.map((a) => {
        const bal = C.accountBalance(state, a.id);
        const n = state.transactions.filter((t) => t.accountId === a.id || t.toAccountId === a.id).length;
        return `<li><div class="grow"><div>${esc(a.name)}</div><div class="meta">${n} transaction${n === 1 ? '' : 's'}</div></div>
          <strong class="num ${bal < 0 ? 'neg' : ''}">${money(bal)}</strong>
          <button class="btn small" type="button" data-action="view-account" data-id="${esc(a.id)}">View</button>
          <button class="btn small" type="button" data-action="edit-account" data-id="${esc(a.id)}">Edit</button></li>`;
      }).join('')}</ul></div>`).join('')}`;
  }

  function renderSettings() {
    const currencies = ['USD', 'CAD', 'EUR', 'GBP', 'AUD', 'NZD', 'JPY', 'INR', 'MXN', 'CHF', 'SEK', 'ZAR'];
    if (!currencies.includes(state.currency)) currencies.push(state.currency);
    const cats = (kind) => sortByName(state.categories.filter((c) => c.kind === kind));
    viewEl.innerHTML = `
      <div class="view-head"><h1>Settings</h1></div>
      <div class="grid cols-2">
        <div class="card"><h2>Preferences</h2>
          <div class="field-row">
            <label class="field"><span>Currency</span><select data-setting="currency">${currencies.map((c) => `<option${c === state.currency ? ' selected' : ''}>${c}</option>`).join('')}</select></label>
            <label class="field"><span>Theme</span><select data-setting="theme">${['system', 'light', 'dark'].map((t) => `<option value="${t}"${t === state.theme ? ' selected' : ''}>${cap(t)}</option>`).join('')}</select></label>
          </div>
        </div>
        <div class="card"><div class="card-head"><h2>Family members</h2><button class="btn small" type="button" data-action="add-member">+ Add</button></div>
          <ul class="list">${state.members.map((m) => `<li><span class="grow">${esc(m.name)}</span>
            <button class="btn small" type="button" data-action="edit-member" data-id="${esc(m.id)}">Edit</button></li>`).join('')}</ul></div>
        <div class="card"><div class="card-head"><h2>Expense categories</h2><button class="btn small" type="button" data-action="add-cat">+ Add</button></div>
          <ul class="list">${cats('expense').map((c) => `<li><span class="grow">${esc(c.name)}</span>
            <span class="muted small">${c.budget ? money(c.budget) + '/mo' : ''}</span>
            <button class="btn small" type="button" data-action="edit-cat" data-id="${esc(c.id)}">Edit</button></li>`).join('')}</ul></div>
        <div class="card"><div class="card-head"><h2>Income categories</h2><button class="btn small" type="button" data-action="add-cat" data-kind="income">+ Add</button></div>
          <ul class="list">${cats('income').map((c) => `<li><span class="grow">${esc(c.name)}</span>
            <button class="btn small" type="button" data-action="edit-cat" data-id="${esc(c.id)}">Edit</button></li>`).join('')}</ul></div>
        <div class="card"><h2>Your data</h2>
          <p class="small muted">Everything is stored privately in this browser on this device — nothing is sent anywhere.
            Export a backup regularly, and import it on another device to move your data.</p>
          <div class="toolbar">
            <button class="btn primary" type="button" data-action="export-json">Export backup</button>
            <button class="btn" type="button" data-action="import-json">Import backup</button>
            <button class="btn" type="button" data-action="load-sample">Load sample data</button>
            <button class="btn danger" type="button" data-action="reset">Erase everything</button>
          </div></div>
      </div>`;
  }

  const RENDERERS = { dashboard: renderDashboard, transactions: renderTransactions, budgets: renderBudgets,
    bills: renderBills, goals: renderGoals, accounts: renderAccounts, settings: renderSettings };

  function render() {
    applyTheme();
    tooltip.classList.remove('show');
    tooltipData = null;
    drawTrend = null;
    document.querySelectorAll('#tabs button').forEach((b) => {
      if (b.dataset.view === ui.view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    // Preserve focus on the search box while typing.
    const active = document.activeElement;
    const refocus = active && active.dataset && active.dataset.filter === 'q' ? active.selectionStart : null;
    RENDERERS[ui.view]();
    if (drawTrend) drawTrend();
    if (refocus != null) {
      const el = viewEl.querySelector('[data-filter=q]');
      if (el) { el.focus(); el.setSelectionRange(refocus, refocus); }
    }
  }

  // ---------- Routing & events ----------

  function route() {
    const v = location.hash.replace('#', '');
    ui.view = VIEWS.includes(v) ? v : 'dashboard';
    render();
  }
  window.addEventListener('hashchange', () => { route(); viewEl.focus({ preventScroll: true }); window.scrollTo(0, 0); });

  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (b) location.hash = b.dataset.view;
  });
  $('#quick-add').addEventListener('click', () => transactionForm());

  const ACTIONS = {
    month: (el) => { ui.month = C.shiftMonth(ui.month, +el.dataset.delta); render(); },
    'tx-month': (el) => { ui.tx.month = C.shiftMonth(ui.tx.month, +el.dataset.delta); render(); },
    'tx-all': () => { ui.tx.month = ui.tx.month ? '' : ui.month; render(); },
    'edit-tx': (el) => transactionForm(byId(state.transactions, el.dataset.id)),
    'add-account': () => accountForm(),
    'edit-account': (el) => accountForm(byId(state.accounts, el.dataset.id)),
    'view-account': (el) => {
      Object.assign(ui.tx, { month: '', q: '', type: '', categoryId: '', memberId: '', accountId: el.dataset.id });
      location.hash = 'transactions';
    },
    'add-cat': (el) => categoryForm(null, el.dataset.kind),
    'edit-cat': (el) => categoryForm(byId(state.categories, el.dataset.id)),
    'add-member': () => memberForm(),
    'edit-member': (el) => memberForm(byId(state.members, el.dataset.id)),
    'add-bill': () => billForm(),
    'edit-bill': (el) => billForm(byId(state.bills, el.dataset.id)),
    'pay-bill': (el) => payBill(byId(state.bills, el.dataset.id)),
    'add-goal': () => goalForm(),
    'edit-goal': (el) => goalForm(byId(state.goals, el.dataset.id)),
    contribute: (el) => contributeForm(byId(state.goals, el.dataset.id)),
    'export-csv': () => {
      const list = filteredTransactions();
      download(`transactions-${C.today()}.csv`, C.transactionsToCSV(state, list), 'text/csv');
      toast(`Exported ${list.length} transactions`);
    },
    'import-csv': async () => {
      const text = await pickFile('.csv,text/csv');
      if (text == null) return;
      try {
        const r = C.importTransactionsCSV(state, text, { accountId: ui.tx.accountId || (state.accounts[0] && state.accounts[0].id) });
        commit(`Imported ${r.added} transaction${r.added === 1 ? '' : 's'}${r.skipped ? `, skipped ${r.skipped}` : ''}${r.created.length ? `. New: ${r.created.join(', ')}` : ''}`);
      } catch (err) { alert(err.message); }
    },
    'export-json': () => {
      download(`family-finances-backup-${C.today()}.json`, JSON.stringify(state, null, 2), 'application/json');
      toast('Backup downloaded');
    },
    'import-json': async () => {
      const text = await pickFile('.json,application/json');
      if (text == null) return;
      try {
        const next = C.normalizeState(JSON.parse(text));
        if (!confirm('Replace all current data with this backup?')) return;
        state = next;
        commit('Backup restored');
      } catch (err) { alert('That file could not be read as a Family Finances backup.'); }
    },
    'load-sample': () => {
      if (state.transactions.length && !confirm('Replace your current data with sample data?')) return;
      state = C.sampleState(C.today());
      ui.month = C.monthKey(C.today());
      commit('Sample data loaded — erase it from Settings when you’re ready to start.');
    },
    reset: () => {
      if (!confirm('Erase ALL data? This cannot be undone. Consider exporting a backup first.')) return;
      state = C.defaultState();
      commit('All data erased');
    },
  };

  viewEl.addEventListener('click', (e) => {
    const nav = e.target.closest('[data-nav]');
    if (nav) { location.hash = nav.dataset.nav; return; }
    const el = e.target.closest('[data-action]');
    if (el && ACTIONS[el.dataset.action]) ACTIONS[el.dataset.action](el);
  });
  viewEl.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr[data-action]')) {
      e.preventDefault();
      ACTIONS[e.target.dataset.action](e.target);
    }
  });
  viewEl.addEventListener('input', (e) => {
    const f = e.target.dataset.filter;
    if (f) { ui.tx[f] = e.target.value; render(); }
  });
  viewEl.addEventListener('change', (e) => {
    const key = e.target.dataset.setting;
    if (key) { state[key] = e.target.value; commit('Saved'); }
  });

  // Keep tabs in sync if the app is open in two browser tabs.
  window.addEventListener('storage', (e) => { if (e.key === STORAGE_KEY && !modal.open) { load(); render(); } });

  load();
  route();
})();
