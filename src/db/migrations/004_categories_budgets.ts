// Category tree, merchant/plaid-category override rules, and versioned
// budgets. No seed data yet: the real category tree and June-2026 budget
// come from Joint_Finances_06-2026.xlsx, which is intentionally never parsed
// or committed here (see .gitignore) — seeding is a follow-up pass once
// someone reads that workbook and maps it to categories deliberately.
export const migration = {
  version: 4,
  name: "categories_budgets",
  sql: `
CREATE TABLE categories (
  category_id TEXT PRIMARY KEY,
  parent_id   TEXT REFERENCES categories(category_id),
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('income','expense','savings','transfer')),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  archived    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE category_rules (
  rule_id          TEXT PRIMARY KEY,
  priority         INTEGER NOT NULL,
  merchant_pattern TEXT,
  payee_pattern    TEXT,
  plaid_category   TEXT,
  account_id       TEXT REFERENCES accounts(account_id),
  amount_min       REAL,
  amount_max       REAL,
  category_id      TEXT NOT NULL REFERENCES categories(category_id),
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL
);

CREATE TABLE budget_versions (
  version_id     TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  notes          TEXT
);

CREATE TABLE budget_lines (
  version_id     TEXT NOT NULL REFERENCES budget_versions(version_id) ON DELETE CASCADE,
  category_id    TEXT NOT NULL REFERENCES categories(category_id),
  person_id      TEXT REFERENCES persons(person_id),
  monthly_amount REAL NOT NULL,
  PRIMARY KEY (version_id, category_id, person_id)
);
`,
};
