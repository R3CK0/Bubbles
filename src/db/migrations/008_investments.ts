// Investment positions and prices, sourced from Plaid /investments once that
// ingestion is built. Contribution-vs-growth decomposition and TWR/MWR are
// computed later from this table + snapshots — nothing extra to store.
export const migration = {
  version: 8,
  name: "investments",
  sql: `
CREATE TABLE securities (
  security_id TEXT PRIMARY KEY,
  ticker      TEXT,
  name        TEXT,
  sec_type    TEXT,
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

CREATE TABLE holdings_snapshots (
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

CREATE TABLE investment_transactions (
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
`,
};
