# Data Model — SQLite Schema v2

*Companion to [PLATFORM_PROPOSAL.md](PLATFORM_PROPOSAL.md). Full DDL for every domain; existing v1 tables (`items`, `accounts`, `transactions`) are kept and extended, not replaced.*

## Conventions

- **IDs**: `TEXT` primary keys — Plaid's natural IDs where they exist, UUIDs elsewhere.
- **Dates**: ISO-8601 `TEXT` (`YYYY-MM-DD`; timestamps `YYYY-MM-DDTHH:MM:SSZ`). SQLite date functions work on these directly.
- **Money**: `REAL`, matching the existing Plaid layer. At household magnitudes double-precision error is far below a cent; all engine outputs round to cents at the boundary. (Revisit to integer-cents only if reconciliation ever shows drift.)
- **Booleans**: `INTEGER` 0/1.
- **Currency**: every money column has a sibling `currency TEXT` defaulting to `'CAD'`; conversion happens at query time via `fx_rates`.
- **JSON**: `TEXT` validated with `json_valid()` CHECK — used only where the payload is genuinely document-shaped (tax tables, scenario params, report data), never for data we filter/aggregate on.
- **Enums**: `TEXT` + `CHECK (x IN (...))` — self-documenting, no lookup-table ceremony.
- **Soft references to persons**: `person_id` is NULLable in most places; `NULL` means *household/joint*.
- `PRAGMA foreign_keys = ON` at every connection open; `schema_migrations` table + numbered migration files replace the current run-once `SCHEMA_SQL`.

## Domain map

```
persons ─┬─ accounts (ext) ─┬─ transactions (ext) ── categories / category_rules
         │                  ├─ account_snapshots          budgets (versioned)
         │                  ├─ holdings_snapshots ── securities ── security_prices
         │                  └─ investment_transactions
         ├─ manual_assets ── manual_asset_valuations
         ├─ debts ── debt_rate_history
         ├─ goals ── goal_line_items
         ├─ plans ── plan_lines            scenarios
         ├─ registered_room / registered_contributions
         └─ tax_profiles / tax_estimates   tax_tables
recurring_payments · fx_rates · alerts · reports · decisions · sync_runs
```

---

## 1. Identity & settings

```sql
CREATE TABLE persons (
  person_id     TEXT PRIMARY KEY,          -- 'nick', 'shanthi'
  display_name  TEXT NOT NULL,
  color         TEXT,                      -- UI accent for person lenses
  created_at    TEXT NOT NULL
);

CREATE TABLE settings (                    -- household-level key/value (base currency, buffer target…)
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
```

## 2. Banking core (v1 tables, extended)

```sql
-- items: unchanged from v1 (+ owner)
ALTER TABLE items ADD COLUMN person_id TEXT REFERENCES persons(person_id);

-- accounts: v1 + ownership, registration, lifecycle
ALTER TABLE accounts ADD COLUMN person_id TEXT REFERENCES persons(person_id);  -- NULL = joint
ALTER TABLE accounts ADD COLUMN registered_type TEXT
  CHECK (registered_type IN ('FHSA','TFSA','RRSP','RESP','NONREG') OR registered_type IS NULL);
ALTER TABLE accounts ADD COLUMN purpose TEXT;          -- freeform: 'emergency fund', 'vacation sinking fund'
ALTER TABLE accounts ADD COLUMN tracked INTEGER NOT NULL DEFAULT 1;   -- deselected in the add-bank wizard: still synced-listed, excluded from all analytics
ALTER TABLE accounts ADD COLUMN classified_at TEXT;    -- NULL = awaiting the classify step; onboarding gates on this
ALTER TABLE accounts ADD COLUMN is_closed INTEGER NOT NULL DEFAULT 0;

-- transactions: v1 + categorization, linking, transfer handling
ALTER TABLE transactions ADD COLUMN category_id TEXT REFERENCES categories(category_id);
ALTER TABLE transactions ADD COLUMN categorization_source TEXT NOT NULL DEFAULT 'plaid'
  CHECK (categorization_source IN ('plaid','rule','manual'));   -- manual always wins; rules re-run never touch manual
ALTER TABLE transactions ADD COLUMN notes TEXT;
ALTER TABLE transactions ADD COLUMN reimbursed_by TEXT
  CHECK (reimbursed_by IN ('work','buildings') OR reimbursed_by IS NULL);  -- nets out of personal spend
ALTER TABLE transactions ADD COLUMN is_transfer INTEGER NOT NULL DEFAULT 0;  -- internal moves, excluded from cash flow
ALTER TABLE transactions ADD COLUMN transfer_group_id TEXT;      -- pairs the two legs of a detected transfer
ALTER TABLE transactions ADD COLUMN recurring_payment_id TEXT REFERENCES recurring_payments(rp_id);

CREATE INDEX idx_transactions_category  ON transactions(category_id);
CREATE INDEX idx_transactions_recurring ON transactions(recurring_payment_id);
```

## 3. History & snapshots (charts need history)

```sql
CREATE TABLE account_snapshots (           -- written by the nightly job; one row per account per day
  account_id        TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  date              TEXT NOT NULL,
  current_balance   REAL,
  available_balance REAL,
  currency          TEXT NOT NULL DEFAULT 'CAD',
  PRIMARY KEY (account_id, date)
);

CREATE TABLE manual_assets (               -- Buildings stake, vehicles — anything Plaid can't see
  asset_id    TEXT PRIMARY KEY,
  person_id   TEXT REFERENCES persons(person_id),
  name        TEXT NOT NULL,
  asset_class TEXT NOT NULL CHECK (asset_class IN ('real_estate','vehicle','private_equity','collectible','other')),
  currency    TEXT NOT NULL DEFAULT 'CAD',
  notes       TEXT,
  archived    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE manual_asset_valuations (     -- periodic revaluation, carried forward until the next one
  asset_id TEXT NOT NULL REFERENCES manual_assets(asset_id) ON DELETE CASCADE,
  date     TEXT NOT NULL,
  value    REAL NOT NULL,
  source   TEXT,                           -- 'municipal assessment', 'estimate'…
  PRIMARY KEY (asset_id, date)
);

CREATE TABLE fx_rates (
  date      TEXT NOT NULL,
  base_ccy  TEXT NOT NULL,                 -- 'USD'
  quote_ccy TEXT NOT NULL,                 -- 'CAD'
  rate      REAL NOT NULL,
  PRIMARY KEY (date, base_ccy, quote_ccy)
);
```

## 4. Categories & budgets

```sql
CREATE TABLE categories (
  category_id TEXT PRIMARY KEY,
  parent_id   TEXT REFERENCES categories(category_id),
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('income','expense','savings','transfer')),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  archived    INTEGER NOT NULL DEFAULT 0
);
-- Seeded from the Excel: Essentials, Entertainment/Lifestyle/Work subscriptions,
-- Vacation, Savings, Donations, Other — with the workbook's line items as children.

CREATE TABLE category_rules (              -- highest priority match wins; re-runnable over history
  rule_id          TEXT PRIMARY KEY,
  priority         INTEGER NOT NULL,
  merchant_pattern TEXT,                   -- SQL LIKE / glob on merchant_name
  payee_pattern    TEXT,
  plaid_category   TEXT,                   -- match Plaid's personal_finance_category
  account_id       TEXT REFERENCES accounts(account_id),
  amount_min       REAL,
  amount_max       REAL,
  category_id      TEXT NOT NULL REFERENCES categories(category_id),
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL
);

CREATE TABLE budget_versions (             -- budgets are versioned; history of past budgets is preserved
  version_id     TEXT PRIMARY KEY,
  name           TEXT NOT NULL,            -- 'July 2026 baseline', 'Post-Greece adjustment'
  effective_from TEXT NOT NULL,            -- first month this version applies ('YYYY-MM-01')
  created_at     TEXT NOT NULL,
  notes          TEXT
);
-- The active budget for month M = version with the greatest effective_from <= M.

CREATE TABLE budget_lines (
  version_id     TEXT NOT NULL REFERENCES budget_versions(version_id) ON DELETE CASCADE,
  category_id    TEXT NOT NULL REFERENCES categories(category_id),
  person_id      TEXT REFERENCES persons(person_id),   -- NULL = joint line
  monthly_amount REAL NOT NULL,
  PRIMARY KEY (version_id, category_id, person_id)
);
```

## 5. Recurring payments & bills

```sql
CREATE TABLE recurring_payments (
  rp_id            TEXT PRIMARY KEY,
  name             TEXT NOT NULL,          -- 'Hydro-Québec', 'Car loan', 'Netflix'
  category_id      TEXT REFERENCES categories(category_id),
  person_id        TEXT REFERENCES persons(person_id),
  account_id       TEXT REFERENCES accounts(account_id),  -- account it debits
  expected_amount  REAL NOT NULL,
  amount_tolerance REAL NOT NULL DEFAULT 0.05,  -- fraction; beyond it → price-creep alert
  currency         TEXT NOT NULL DEFAULT 'CAD',
  frequency        TEXT NOT NULL CHECK (frequency IN ('weekly','biweekly','monthly','quarterly','semiannual','annual','custom')),
  interval_days    INTEGER,                -- only for 'custom'
  anchor_date      TEXT NOT NULL,          -- first known due date; schedule derives from this
  next_due_date    TEXT NOT NULL,          -- maintained by the matcher job
  end_date         TEXT,                   -- loans end; NULL = open-ended
  autopay          INTEGER NOT NULL DEFAULT 1,
  reimbursed_by    TEXT CHECK (reimbursed_by IN ('work','buildings') OR reimbursed_by IS NULL),
  debt_id          TEXT REFERENCES debts(debt_id),  -- set for loan payments → feeds amortization
  source           TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','detected')),
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','ended','proposed')),
  created_at       TEXT NOT NULL
);
-- 'proposed' = auto-detected, awaiting user confirmation in the dashboard.
-- Matched charges are linked via transactions.recurring_payment_id.
```

## 6. Debts

```sql
CREATE TABLE debts (
  debt_id            TEXT PRIMARY KEY,
  person_id          TEXT REFERENCES persons(person_id),
  account_id         TEXT REFERENCES accounts(account_id),  -- set when synced via Plaid liabilities (credit card)
  name               TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('credit_card','student_loan','line_of_credit','auto_loan','mortgage','personal','other')),
  original_principal REAL,
  current_balance    REAL NOT NULL,        -- for synced debts, refreshed from account_snapshots
  apr                REAL NOT NULL,        -- annual %, e.g. 20.99
  min_payment        REAL,
  payment_day        INTEGER,              -- day of month
  maturity_date      TEXT,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paid_off','archived')),
  created_at         TEXT NOT NULL
);

CREATE TABLE debt_rate_history (           -- variable rates (LOC, future mortgage renewals)
  debt_id        TEXT NOT NULL REFERENCES debts(debt_id) ON DELETE CASCADE,
  effective_date TEXT NOT NULL,
  apr            REAL NOT NULL,
  PRIMARY KEY (debt_id, effective_date)
);
-- Payments are transactions matched via the linked recurring_payment; payoff projections
-- are computed by the engine, and *committed* payoff strategies live in plans/plan_lines.
```

## 7. Goals, plans & scenarios

```sql
CREATE TABLE goals (
  goal_id           TEXT PRIMARY KEY,
  goal_type         TEXT NOT NULL CHECK (goal_type IN ('house','kid','trip','purchase','savings','event','emergency_fund','debt_payoff')),
  name              TEXT NOT NULL,         -- 'Down payment', 'Greece 2027', 'Wedding'
  person_id         TEXT REFERENCES persons(person_id),   -- NULL = joint
  target_amount     REAL NOT NULL,
  target_date       TEXT,                  -- NULL = open-ended (emergency fund)
  priority          INTEGER NOT NULL DEFAULT 3,           -- 1 = highest
  linked_account_id TEXT REFERENCES accounts(account_id), -- where funding accumulates (e.g. FHSA)
  linked_debt_id    TEXT REFERENCES debts(debt_id),       -- for debt_payoff goals
  funded_amount     REAL NOT NULL DEFAULT 0,              -- maintained from matched contributions
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','achieved','abandoned','paused')),
  params_json       TEXT CHECK (params_json IS NULL OR json_valid(params_json)),
  -- goal-type-specific inputs: house {price, downpayment_pct, rate}, kid {leave_months, childcare_monthly}…
  created_at        TEXT NOT NULL,
  notes             TEXT
);

CREATE TABLE goal_line_items (             -- itemized envelopes (wedding: shoes $300, favors $1000…)
  line_id   TEXT PRIMARY KEY,
  goal_id   TEXT NOT NULL REFERENCES goals(goal_id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  amount    REAL NOT NULL,
  due_date  TEXT,
  status    TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','deposit_paid','paid','cancelled')),
  transaction_id TEXT REFERENCES transactions(transaction_id)  -- linked once spent
);

CREATE TABLE plans (                       -- one approved allocation of monthly free cash flow.
  plan_id     TEXT PRIMARY KEY,            -- unifies goal funding, debt paydown, and FHSA/RRSP/TFSA
  name        TEXT NOT NULL,               -- contributions from the tax optimizer in ONE schedule,
  created_at  TEXT NOT NULL,               -- because they compete for the same dollars.
  approved_at TEXT,
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','superseded','completed')),
  solver_inputs_json TEXT CHECK (solver_inputs_json IS NULL OR json_valid(solver_inputs_json)),
  notes       TEXT
);
-- Exactly one plan is 'active'; approving a new one supersedes the old (history kept).

CREATE TABLE plan_lines (                  -- the funding schedule, one row per month per destination
  plan_id     TEXT NOT NULL REFERENCES plans(plan_id) ON DELETE CASCADE,
  month       TEXT NOT NULL,               -- 'YYYY-MM'
  person_id   TEXT REFERENCES persons(person_id),
  target_type TEXT NOT NULL CHECK (target_type IN ('goal','debt','fhsa','rrsp','tfsa','buffer')),
  target_id   TEXT,                        -- goal_id or debt_id when applicable
  amount      REAL NOT NULL,
  PRIMARY KEY (plan_id, month, person_id, target_type, target_id)
);
-- On-track/off-track = plan_lines vs. actual matched contributions for the month.

CREATE TABLE scenarios (                   -- what-if worlds; never touch real tables
  scenario_id TEXT PRIMARY KEY,
  name        TEXT NOT NULL,               -- 'House in 2027 @ 6%', 'One income for 12 months'
  params_json TEXT NOT NULL CHECK (json_valid(params_json)),  -- overrides: income deltas, rate, goal shifts
  created_at  TEXT NOT NULL,
  notes       TEXT
);
```

## 8. Investments

```sql
CREATE TABLE securities (
  security_id TEXT PRIMARY KEY,            -- Plaid security_id
  ticker      TEXT,
  name        TEXT,
  sec_type    TEXT,                        -- 'equity','etf','mutual fund','cash','fixed income','crypto'
  currency    TEXT NOT NULL DEFAULT 'CAD',
  isin        TEXT,
  raw_json    TEXT
);

CREATE TABLE security_prices (
  security_id TEXT NOT NULL REFERENCES securities(security_id) ON DELETE CASCADE,
  date        TEXT NOT NULL,
  close_price REAL NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'CAD',
  PRIMARY KEY (security_id, date)
);

CREATE TABLE holdings_snapshots (          -- nightly position snapshot per account per security
  account_id  TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  security_id TEXT NOT NULL REFERENCES securities(security_id),
  date        TEXT NOT NULL,
  quantity    REAL NOT NULL,
  price       REAL,
  value       REAL NOT NULL,
  cost_basis  REAL,
  currency    TEXT NOT NULL DEFAULT 'CAD',
  PRIMARY KEY (account_id, security_id, date)
);

CREATE TABLE investment_transactions (     -- from Plaid /investments/transactions
  inv_tx_id   TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  security_id TEXT REFERENCES securities(security_id),
  date        TEXT NOT NULL,
  tx_type     TEXT NOT NULL CHECK (tx_type IN ('buy','sell','dividend','interest','contribution','withdrawal','fee','transfer','other')),
  quantity    REAL,
  price       REAL,
  amount      REAL NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'CAD',
  raw_json    TEXT
);
CREATE INDEX idx_invtx_account_date ON investment_transactions(account_id, date);
-- contribution-vs-growth decomposition = Σ contributions/withdrawals vs. Δ holdings value;
-- dividends and TWR/MWR compute from this table + snapshots. Nothing extra to store.
```

## 9. Registered accounts & tax

```sql
CREATE TABLE registered_room (             -- entered once/yr from CRA + Revenu Québec MyAccount
  person_id    TEXT NOT NULL REFERENCES persons(person_id),
  account_type TEXT NOT NULL CHECK (account_type IN ('FHSA','TFSA','RRSP')),
  tax_year     INTEGER NOT NULL,
  room_amount  REAL NOT NULL,              -- total room available for that year (incl. carry-forward)
  as_of        TEXT NOT NULL,
  source       TEXT,                       -- 'CRA MyAccount 2026-03-02'
  PRIMARY KEY (person_id, account_type, tax_year)
);

CREATE TABLE registered_contributions (    -- auto-created from matched transfers into registered accounts
  contrib_id        TEXT PRIMARY KEY,
  person_id         TEXT NOT NULL REFERENCES persons(person_id),
  account_type      TEXT NOT NULL CHECK (account_type IN ('FHSA','TFSA','RRSP','RRSP_SPOUSAL')),
  account_id        TEXT REFERENCES accounts(account_id),
  date              TEXT NOT NULL,
  amount            REAL NOT NULL,
  transaction_id    TEXT REFERENCES transactions(transaction_id),
  tax_year          INTEGER NOT NULL,      -- contribution year (RRSP first-60-days handled here)
  deduction_year    INTEGER,               -- NULL = not yet deducted → carry-forward is a first-class fact
  contributor_person_id TEXT REFERENCES persons(person_id)  -- for spousal RRSP: who gets the deduction
);

CREATE TABLE tax_profiles (                -- per person per tax year: what the calculator can't derive
  person_id         TEXT NOT NULL REFERENCES persons(person_id),
  tax_year          INTEGER NOT NULL,
  employment_income REAL,                  -- gross salary (payroll deposits are net — gross lives here)
  withholding_paid  REAL,                  -- source deductions to date
  other_income_json TEXT CHECK (other_income_json IS NULL OR json_valid(other_income_json)),
  carryforwards_json TEXT CHECK (carryforwards_json IS NULL OR json_valid(carryforwards_json)),
  -- tuition credits, capital losses, RRSP undeducted — document-shaped, engine-consumed
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (person_id, tax_year)
);

CREATE TABLE tax_tables (                  -- versioned bracket/rate/credit data; yearly data update, no code change
  jurisdiction TEXT NOT NULL CHECK (jurisdiction IN ('CA','QC')),
  tax_year     INTEGER NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  -- {brackets:[{upTo,rate}…], bpa, abatement, qpp:{…}, qpip:{…}, ei:{…}, credits:{donation:[…],…}}
  PRIMARY KEY (jurisdiction, tax_year, version)
);

CREATE TABLE tax_estimates (               -- audit trail: every calculator/optimizer run that was shown
  estimate_id  TEXT PRIMARY KEY,
  person_id    TEXT REFERENCES persons(person_id),   -- NULL = household combined
  scenario_id  TEXT REFERENCES scenarios(scenario_id),
  tax_year     INTEGER NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('estimate','optimization')),
  computed_at  TEXT NOT NULL,
  inputs_json  TEXT NOT NULL CHECK (json_valid(inputs_json)),
  results_json TEXT NOT NULL CHECK (json_valid(results_json))
  -- estimate: {taxable_income, fed_tax, qc_tax, marginal, average, withheld, balance}
  -- optimization: {per_person: {fhsa, rrsp, tfsa}, tax_saved, refund, schedule}
);
```

## 10. Operations

```sql
CREATE TABLE alerts (
  alert_id        TEXT PRIMARY KEY,
  alert_type      TEXT NOT NULL,           -- 'overspend_pace','low_balance','price_creep','goal_off_track',
                                           -- 'renewal_ahead','room_deadline','allocation_drift','stale_sync'
  severity        TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
  title           TEXT NOT NULL,
  body            TEXT,
  payload_json    TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  created_at      TEXT NOT NULL,
  acknowledged_at TEXT,
  acknowledged_by TEXT REFERENCES persons(person_id)
);
CREATE INDEX idx_alerts_open ON alerts(created_at) WHERE acknowledged_at IS NULL;

CREATE TABLE reports (                     -- archived monthly/quarterly reviews
  report_id    TEXT PRIMARY KEY,
  report_type  TEXT NOT NULL CHECK (report_type IN ('monthly','quarterly','annual','adhoc')),
  period_start TEXT NOT NULL,
  period_end   TEXT NOT NULL,
  content_md   TEXT NOT NULL,              -- rendered narrative
  data_json    TEXT CHECK (data_json IS NULL OR json_valid(data_json)),  -- the numbers behind it
  created_at   TEXT NOT NULL
);

CREATE TABLE decisions (                   -- the couple's decision log
  decision_id TEXT PRIMARY KEY,
  date        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT,
  links_json  TEXT CHECK (links_json IS NULL OR json_valid(links_json))  -- refs to goals/plans/reports
);

CREATE TABLE sync_runs (                   -- data-health: every nightly job run
  run_id      TEXT PRIMARY KEY,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL CHECK (status IN ('running','success','partial','failed')),
  stats_json  TEXT CHECK (stats_json IS NULL OR json_valid(stats_json))
  -- {items_synced, tx_added, tx_modified, snapshots_written, errors:[…]}
);
```

## 11. Views (computed, never stored)

```sql
-- Daily net worth: bank/investment balances + carried-forward manual asset values − manual debts
CREATE VIEW v_net_worth_daily AS ...;

-- The Excel "Financial Flux" matrix: month × category actuals (transfers excluded, reimbursements netted)
CREATE VIEW v_monthly_category_actuals AS ...;

-- Budget vs. actual for the active budget version of each month
CREATE VIEW v_budget_vs_actual AS ...;

-- Bills due in the next N days with running projected balance per account
CREATE VIEW v_upcoming_bills AS ...;

-- Remaining contribution room = registered_room − Σ registered_contributions (per person/type/year)
CREATE VIEW v_contribution_room AS ...;
```
*(Definitions written during Phase 1 implementation; listed here to fix the contract — anything derivable stays a view, only history and user intent get tables.)*

---

## Design decisions worth noting

1. **`plans` unifies goals, debt paydown, and tax-optimizer output.** They all compete for the same monthly dollars, so the approved allocation must be a single schedule — otherwise the affordability solver and the tax optimizer would silently double-spend free cash flow.
2. **`deduction_year` on RRSP contributions** makes carry-forward a stored fact, not a calculation — the optimizer's "defer the deduction to a higher-income year" strategy needs it, and so does the couple's audit trail.
3. **Snapshots are append-only, analytics are views.** Only two kinds of data get tables: history that can't be reconstructed (balances, positions, prices) and user intent (budgets, goals, rules, approvals). Everything else derives.
4. **Manual categorization always survives** (`categorization_source='manual'` is never overwritten by rule re-runs) — trust in the category data is what makes every downstream number believable.
5. **Transfers are first-class** (`is_transfer`, `transfer_group_id`): moving $833 to the vacation account must not count as spending, and contributions must not count as income in the receiving account.
6. **Tax bracket data is data** (`tax_tables` JSON, versioned) — January updates are an INSERT, not a release.
7. **Versioned budgets** preserve what the budget *was* in March when you review March in July.

## Migration plan (Phase 1)

1. `001_schema_migrations.sql` — bookkeeping table.
2. `002_persons_settings.sql` — persons seeded ('nick', 'shanthi'), base settings.
3. `003_extend_banking.sql` — ALTERs on items/accounts/transactions + new indexes.
4. `004_categories_budgets.sql` — categories + rules + budget tables, **seeded from `Joint_Finances_06-2026.xlsx`** (category tree and the June-2026 budget as `budget_versions` row 1).
5. `005_history.sql` — snapshots, manual assets, fx_rates.
6. `006_recurring_debts.sql` — recurring_payments, debts (+ seed the known debts and workbook recurring lines).
7. `007_goals_plans.sql` — goals, line items, plans, scenarios (+ seed wedding/Greece from Upcoming Expenses).
8. `008_investments.sql` — securities, prices, holdings, investment transactions.
9. `009_tax.sql` — room, contributions, profiles, tax_tables (+ 2026 CA/QC payloads).
10. `010_ops_views.sql` — alerts, reports, decisions, sync_runs, all views.
