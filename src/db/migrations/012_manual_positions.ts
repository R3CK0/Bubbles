// Manual portfolio positions: the user maintains what each investment
// account holds (stocks/ETFs/crypto priced from market data by symbol;
// options/cash carried at user-maintained value). Rows are versioned by
// effective window — editing a position closes the old row (end_date) and
// inserts the new one, so historical snapshots rebuild faithfully.
// Replaces the Plaid investments product (production-tier only).
export const migration = {
  version: 12,
  name: "manual_positions",
  sql: `
CREATE TABLE manual_positions (
  position_id  TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  symbol       TEXT,
  name         TEXT NOT NULL,
  asset_type   TEXT NOT NULL CHECK (asset_type IN ('stock','etf','crypto','option','cash','other')),
  quantity     REAL NOT NULL,
  book_cost    REAL,
  manual_value REAL,
  currency     TEXT NOT NULL DEFAULT 'CAD',
  effective_date TEXT NOT NULL,
  end_date     TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_manual_positions_account ON manual_positions(account_id, effective_date);
`,
};
