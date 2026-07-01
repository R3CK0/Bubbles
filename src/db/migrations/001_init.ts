// Bookkeeping table (also created defensively by the migrator itself before
// this file ever runs) plus the original v1 tables: items/accounts/transactions.
// Kept here, not replaced, per docs/DATA_MODEL.md — every later migration only
// extends these via ALTER TABLE.
export const migration = {
  version: 1,
  name: "init",
  sql: `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE items (
  item_id TEXT PRIMARY KEY,
  institution_id TEXT,
  institution_name TEXT,
  linked_at TEXT NOT NULL,
  last_synced_at TEXT,
  sync_cursor TEXT
);

CREATE TABLE accounts (
  account_id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
  name TEXT,
  official_name TEXT,
  mask TEXT,
  type TEXT,
  subtype TEXT,
  current_balance REAL,
  available_balance REAL,
  iso_currency_code TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE transactions (
  transaction_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  iso_currency_code TEXT,
  date TEXT NOT NULL,
  datetime TEXT,
  payee TEXT,
  merchant_name TEXT,
  type TEXT,
  pending INTEGER NOT NULL DEFAULT 0,
  personal_finance_category_primary TEXT,
  personal_finance_category_detailed TEXT,
  removed INTEGER NOT NULL DEFAULT 0,
  raw_json TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_transactions_date ON transactions(date);
CREATE INDEX idx_transactions_account ON transactions(account_id);
CREATE INDEX idx_transactions_item ON transactions(item_id);
`,
};
