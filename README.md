# Family Finances

A private, no-sign-up personal finance app for tracking your family's money. It runs entirely in your web browser and has no server, no account and no build step. Your data never leaves your device.

## Features

- **Dashboard**: this month's income, spending, savings rate and net worth, compared with last month. Also a 6‑month income vs. spending chart, spending by category and by family member, upcoming bills, goal progress and recent transactions.
- **Transactions**: record income, expenses and transfers between accounts. You can tag each one with a category and a family member, search and filter the list, and import or export CSV.
- **Budgets**: set a monthly limit per category, with on‑track, nearly‑there and over‑budget indicators.
- **Bills**: track recurring bills (weekly to yearly) and see what's due soon. Tapping **Pay** records the payment and moves the bill to its next due date.
- **Goals**: track savings goals (vacation, college fund, and so on) and see how much to set aside each month to hit the target date.
- **Accounts**: track checking, savings, credit cards, cash and investment accounts, with live balances, assets, debts and net worth.
- **Settings**: family members, categories, currency, light/dark theme, backup/restore and sample data.

## Getting started

Open `index.html` in any modern browser and you're up and running. You can also serve the folder locally:

```sh
npm start            # serves at http://localhost:8080
```

On first launch you can click **load sample data** to explore the app. When you're ready to start for real, go to **Settings → Erase everything**. Then:

1. Add your accounts on the **Accounts** tab, with their current balances as the starting balance.
2. Add family members, and adjust categories, in **Settings**.
3. Set monthly budgets on the **Budgets** tab.
4. Add recurring bills and savings goals.
5. Record transactions with **+ Add transaction**, or import a CSV downloaded from your bank.

### Using it on your phone

Host the folder anywhere that serves static files, such as **GitHub Pages** (Settings → Pages → deploy from this branch). Then open the URL on your phone and choose **Add to Home Screen**.

## Your data

- Everything is saved in your browser's local storage on that one device and in that one browser.
- **Export a backup regularly** (Settings → Export backup). Clearing browser data deletes your records.
- To share between devices or family members, export a backup on one device and import it on the other.

### CSV import

Bank exports usually work as-is. The file needs a `Date` column plus either an `Amount` column (negative amounts are spending) or separate `Debit`/`Credit` columns. Optional columns are `Description`/`Payee`, `Category`, `Account`, `Member` and `Notes`. Unknown category, account or member names are created automatically. Dates are read as `YYYY-MM-DD` or US-style `MM/DD/YYYY`.

## Development

- `js/core.js` holds the finance logic: balances, summaries, budgets, dates, CSV. It's made of pure functions and amounts are stored as integer cents.
- `js/app.js` holds the UI, written in vanilla JavaScript.
- `styles.css` holds the styles, with light and dark themes.

Run the tests with:

```sh
npm test
```
