// Recurring payment registry and the debt module. No seed data yet: the
// known debts and the workbook's recurring lines both come from
// Joint_Finances_06-2026.xlsx (never parsed/committed here) — seeding is a
// follow-up pass, same as categories/budgets.
export const migration = {
  version: 6,
  name: "recurring_debts",
  sql: `
CREATE TABLE recurring_payments (
  rp_id            TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  category_id      TEXT REFERENCES categories(category_id),
  person_id        TEXT REFERENCES persons(person_id),
  account_id       TEXT REFERENCES accounts(account_id),
  expected_amount  REAL NOT NULL,
  amount_tolerance REAL NOT NULL DEFAULT 0.05,
  currency         TEXT NOT NULL DEFAULT 'CAD',
  frequency        TEXT NOT NULL CHECK (frequency IN ('weekly','biweekly','monthly','quarterly','semiannual','annual','custom')),
  interval_days    INTEGER,
  anchor_date      TEXT NOT NULL,
  next_due_date    TEXT NOT NULL,
  end_date         TEXT,
  autopay          INTEGER NOT NULL DEFAULT 1,
  reimbursed_by    TEXT CHECK (reimbursed_by IN ('work','buildings') OR reimbursed_by IS NULL),
  debt_id          TEXT REFERENCES debts(debt_id),
  source           TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','detected')),
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','ended','proposed')),
  created_at       TEXT NOT NULL
);

CREATE TABLE debts (
  debt_id            TEXT PRIMARY KEY,
  person_id          TEXT REFERENCES persons(person_id),
  account_id         TEXT REFERENCES accounts(account_id),
  name               TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('credit_card','student_loan','line_of_credit','auto_loan','mortgage','personal','other')),
  original_principal REAL,
  current_balance    REAL NOT NULL,
  apr                REAL NOT NULL,
  min_payment        REAL,
  payment_day        INTEGER,
  maturity_date      TEXT,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paid_off','archived')),
  created_at         TEXT NOT NULL
);

CREATE TABLE debt_rate_history (
  debt_id        TEXT NOT NULL REFERENCES debts(debt_id) ON DELETE CASCADE,
  effective_date TEXT NOT NULL,
  apr            REAL NOT NULL,
  PRIMARY KEY (debt_id, effective_date)
);
`,
};
