// Append-only history: daily balance snapshots (charts need history, not
// just current state), manual/illiquid assets with periodic revaluation,
// and FX rates for cross-currency reporting.
export const migration = {
  version: 5,
  name: "history",
  sql: `
CREATE TABLE account_snapshots (
  account_id        TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  date              TEXT NOT NULL,
  current_balance   REAL,
  available_balance REAL,
  currency          TEXT NOT NULL DEFAULT 'CAD',
  PRIMARY KEY (account_id, date)
);

CREATE TABLE manual_assets (
  asset_id    TEXT PRIMARY KEY,
  person_id   TEXT REFERENCES persons(person_id),
  name        TEXT NOT NULL,
  asset_class TEXT NOT NULL CHECK (asset_class IN ('real_estate','vehicle','private_equity','collectible','other')),
  currency    TEXT NOT NULL DEFAULT 'CAD',
  notes       TEXT,
  archived    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE manual_asset_valuations (
  asset_id TEXT NOT NULL REFERENCES manual_assets(asset_id) ON DELETE CASCADE,
  date     TEXT NOT NULL,
  value    REAL NOT NULL,
  source   TEXT,
  PRIMARY KEY (asset_id, date)
);

CREATE TABLE fx_rates (
  date      TEXT NOT NULL,
  base_ccy  TEXT NOT NULL,
  quote_ccy TEXT NOT NULL,
  rate      REAL NOT NULL,
  PRIMARY KEY (date, base_ccy, quote_ccy)
);
`,
};
