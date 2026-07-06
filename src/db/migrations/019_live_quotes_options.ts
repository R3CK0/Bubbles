// Live market data: intraday quote cache + resolved option contracts, and a
// widened manual_positions.asset_type so the portfolio can hold currency (FX)
// and commodity/futures positions alongside stocks/ETFs/options/crypto.
//
//  - security_quotes : latest intraday price per symbol (5-min refresh job).
//      Separate from security_prices (the authoritative daily close): quotes
//      are a live cache with a timestamp, so the UI can show "as of HH:MM"
//      and a change vs. previous close without polluting daily history.
//  - option_contracts : the underlying/expiry/strike a contract symbol resolves
//      to, filled when the user picks a contract from the chain, so an option
//      position renders as "AAPL 2026-01-16 C 150" rather than a raw OCC symbol.
//
// manual_positions gets rebuilt (SQLite can't ALTER a CHECK) to add the two
// new asset types; nothing references it, so the child-table rebuild is safe.
export const migration = {
  version: 19,
  name: "live_quotes_options",
  sql: `
CREATE TABLE security_quotes (
  security_id   TEXT PRIMARY KEY,
  price         REAL NOT NULL,
  prev_close    REAL,
  change_pct    REAL,
  currency      TEXT NOT NULL DEFAULT 'CAD',
  market_state  TEXT,
  source        TEXT NOT NULL DEFAULT 'yahoo',
  as_of         TEXT NOT NULL,
  raw_json      TEXT
);

CREATE TABLE option_contracts (
  contract_symbol TEXT PRIMARY KEY,
  underlying      TEXT NOT NULL,
  expiry          TEXT NOT NULL,
  strike          REAL NOT NULL,
  option_type     TEXT NOT NULL CHECK (option_type IN ('call','put')),
  currency        TEXT NOT NULL DEFAULT 'USD',
  raw_json        TEXT
);
CREATE INDEX idx_option_contracts_underlying ON option_contracts(underlying, expiry);

CREATE TABLE manual_positions_new (
  position_id  TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  symbol       TEXT,
  name         TEXT NOT NULL,
  asset_type   TEXT NOT NULL CHECK (asset_type IN ('stock','etf','crypto','option','currency','commodity','cash','other')),
  quantity     REAL NOT NULL,
  book_cost    REAL,
  manual_value REAL,
  currency     TEXT NOT NULL DEFAULT 'CAD',
  effective_date TEXT NOT NULL,
  end_date     TEXT,
  created_at   TEXT NOT NULL
);
INSERT INTO manual_positions_new SELECT * FROM manual_positions;
DROP TABLE manual_positions;
ALTER TABLE manual_positions_new RENAME TO manual_positions;
CREATE INDEX idx_manual_positions_account ON manual_positions(account_id, effective_date);
`,
};
