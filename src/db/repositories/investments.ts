/**
 * db/repositories/investments.ts — data access for securities, prices,
 * holdings snapshots, investment transactions.
 */
import { getDb } from "../db.js";
import type { HoldingPoint, SecurityMeta } from "../../analytics/portfolio.js";

export interface SecurityRow {
  security_id: string;
  ticker: string | null;
  name: string | null;
  sec_type: string | null;
  currency: string;
  isin: string | null;
  raw_json: string | null;
}

export function upsertSecurities(rows: SecurityRow[]): void {
  const stmt = getDb().prepare(
    `INSERT INTO securities (security_id, ticker, name, sec_type, currency, isin, raw_json)
     VALUES (@security_id, @ticker, @name, @sec_type, @currency, @isin, @raw_json)
     ON CONFLICT(security_id) DO UPDATE SET
       ticker = excluded.ticker, name = excluded.name, sec_type = excluded.sec_type,
       currency = excluded.currency, isin = excluded.isin, raw_json = excluded.raw_json`,
  );
  const run = getDb().transaction((all: SecurityRow[]) => {
    for (const r of all) stmt.run(r);
  });
  run(rows);
}

export function securityExists(securityId: string): boolean {
  return Boolean(getDb().prepare(`SELECT 1 FROM securities WHERE security_id = ?`).get(securityId));
}

export function listSecurities(): SecurityRow[] {
  return getDb().prepare(`SELECT * FROM securities`).all() as SecurityRow[];
}

export function toSecurityMeta(row: SecurityRow): SecurityMeta {
  return { securityId: row.security_id, ticker: row.ticker, name: row.name, secType: row.sec_type };
}

export function upsertPrices(rows: { security_id: string; date: string; close_price: number; currency: string }[]): void {
  const stmt = getDb().prepare(
    `INSERT OR REPLACE INTO security_prices (security_id, date, close_price, currency) VALUES (@security_id, @date, @close_price, @currency)`,
  );
  const run = getDb().transaction((all: typeof rows) => {
    for (const r of all) stmt.run(r);
  });
  run(rows);
}

// ---- live intraday quotes (a cache; security_prices stays authoritative) ----

export interface QuoteRow {
  security_id: string;
  price: number;
  prev_close: number | null;
  change_pct: number | null;
  currency: string;
  market_state: string | null;
  source: string;
  as_of: string;
  raw_json: string | null;
}

export function upsertQuotes(rows: QuoteRow[]): void {
  const stmt = getDb().prepare(
    `INSERT INTO security_quotes (security_id, price, prev_close, change_pct, currency, market_state, source, as_of, raw_json)
     VALUES (@security_id, @price, @prev_close, @change_pct, @currency, @market_state, @source, @as_of, @raw_json)
     ON CONFLICT(security_id) DO UPDATE SET
       price = excluded.price, prev_close = excluded.prev_close, change_pct = excluded.change_pct,
       currency = excluded.currency, market_state = excluded.market_state, source = excluded.source,
       as_of = excluded.as_of, raw_json = excluded.raw_json`,
  );
  const run = getDb().transaction((all: QuoteRow[]) => {
    for (const r of all) stmt.run(r);
  });
  run(rows);
}

/** Latest quote per symbol, keyed by security_id, for live enrichment. */
export function quotesBySymbol(): Map<string, QuoteRow> {
  const rows = getDb().prepare(`SELECT * FROM security_quotes`).all() as QuoteRow[];
  return new Map(rows.map((r) => [r.security_id, r]));
}

/** Most recent quote timestamp across all symbols (the portfolio "as of"). */
export function latestQuoteTime(): string | null {
  const row = getDb().prepare(`SELECT MAX(as_of) AS t FROM security_quotes`).get() as { t: string | null };
  return row.t;
}

// ---- resolved option contracts (underlying/expiry/strike for a contract) ----

export interface OptionContractRow {
  contract_symbol: string;
  underlying: string;
  expiry: string;
  strike: number;
  option_type: "call" | "put";
  currency: string;
  raw_json: string | null;
}

export function upsertOptionContract(row: OptionContractRow): void {
  getDb()
    .prepare(
      `INSERT INTO option_contracts (contract_symbol, underlying, expiry, strike, option_type, currency, raw_json)
       VALUES (@contract_symbol, @underlying, @expiry, @strike, @option_type, @currency, @raw_json)
       ON CONFLICT(contract_symbol) DO UPDATE SET
         underlying = excluded.underlying, expiry = excluded.expiry, strike = excluded.strike,
         option_type = excluded.option_type, currency = excluded.currency, raw_json = excluded.raw_json`,
    )
    .run(row);
}

export function optionContractsFor(symbols: string[]): Map<string, OptionContractRow> {
  if (symbols.length === 0) return new Map();
  const placeholders = symbols.map(() => "?").join(",");
  const rows = getDb()
    .prepare(`SELECT * FROM option_contracts WHERE contract_symbol IN (${placeholders})`)
    .all(...symbols) as OptionContractRow[];
  return new Map(rows.map((r) => [r.contract_symbol, r]));
}

export interface HoldingSnapshotWrite {
  account_id: string;
  security_id: string;
  date: string;
  quantity: number;
  price: number | null;
  value: number;
  cost_basis: number | null;
  currency: string;
}

export function writeHoldingsSnapshot(rows: HoldingSnapshotWrite[]): number {
  const stmt = getDb().prepare(
    `INSERT OR REPLACE INTO holdings_snapshots (account_id, security_id, date, quantity, price, value, cost_basis, currency)
     VALUES (@account_id, @security_id, @date, @quantity, @price, @value, @cost_basis, @currency)`,
  );
  const run = getDb().transaction((all: HoldingSnapshotWrite[]) => {
    for (const r of all) stmt.run(r);
  });
  run(rows);
  return rows.length;
}

/** Holdings joined with account ownership, as analytics HoldingPoint rows. */
export function holdingsRange(range: { start: string; end: string }): HoldingPoint[] {
  const rows = getDb()
    .prepare(
      `SELECT h.account_id, a.person_id, h.security_id, h.date, h.quantity, h.value, h.cost_basis
       FROM holdings_snapshots h
       JOIN accounts a ON a.account_id = h.account_id
       WHERE a.tracked = 1 AND h.date >= ? AND h.date <= ?
       ORDER BY h.date`,
    )
    .all(range.start, range.end) as {
    account_id: string;
    person_id: string | null;
    security_id: string;
    date: string;
    quantity: number;
    value: number;
    cost_basis: number | null;
  }[];
  return rows.map((r) => ({
    accountId: r.account_id,
    personId: r.person_id,
    securityId: r.security_id,
    date: r.date,
    quantity: r.quantity,
    value: r.value,
    costBasis: r.cost_basis,
  }));
}

export interface InvestmentTxRow {
  inv_tx_id: string;
  account_id: string;
  security_id: string | null;
  date: string;
  tx_type: "buy" | "sell" | "dividend" | "interest" | "contribution" | "withdrawal" | "fee" | "transfer" | "other";
  quantity: number | null;
  price: number | null;
  amount: number;
  currency: string;
  raw_json: string | null;
}

export function upsertInvestmentTransactions(rows: InvestmentTxRow[]): void {
  const stmt = getDb().prepare(
    `INSERT OR REPLACE INTO investment_transactions (inv_tx_id, account_id, security_id, date, tx_type, quantity, price, amount, currency, raw_json)
     VALUES (@inv_tx_id, @account_id, @security_id, @date, @tx_type, @quantity, @price, @amount, @currency, @raw_json)`,
  );
  const run = getDb().transaction((all: InvestmentTxRow[]) => {
    for (const r of all) stmt.run(r);
  });
  run(rows);
}

/**
 * External cash flows into/out of investment accounts, from the BANK rail:
 * every transaction on an investment-type account is a contribution or
 * withdrawal from the portfolio's perspective (buys/sells happen inside the
 * brokerage and never hit this table). Engine sign: inflow > 0.
 */
export function bankFlowsForInvestmentAccounts(range: { start: string; end: string }): { date: string; amount: number; person_id: string | null }[] {
  return (
    getDb()
      .prepare(
        `SELECT t.date, -t.amount AS amount, a.person_id FROM transactions t
         JOIN accounts a ON a.account_id = t.account_id
         WHERE a.tracked = 1 AND a.type = 'investment' AND t.removed = 0
           AND t.date >= ? AND t.date <= ? ORDER BY t.date`,
      )
      .all(range.start, range.end) as { date: string; amount: number; person_id: string | null }[]
  );
}

// ---- manual positions (user-maintained portfolio state) ----

export interface ManualPositionRow {
  position_id: string;
  account_id: string;
  symbol: string | null;
  name: string;
  asset_type: "stock" | "etf" | "crypto" | "option" | "currency" | "commodity" | "cash" | "other";
  quantity: number;
  book_cost: number | null;
  manual_value: number | null;
  currency: string;
  effective_date: string;
  end_date: string | null;
  created_at: string;
}

export function listPositions(accountId?: string, activeOnly = true): ManualPositionRow[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (accountId) {
    clauses.push("account_id = @accountId");
    params.accountId = accountId;
  }
  if (activeOnly) clauses.push("end_date IS NULL");
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return getDb()
    .prepare(`SELECT * FROM manual_positions ${where} ORDER BY account_id, name`)
    .all(params) as ManualPositionRow[];
}

export function getPosition(positionId: string): ManualPositionRow | undefined {
  return getDb().prepare(`SELECT * FROM manual_positions WHERE position_id = ?`).get(positionId) as
    | ManualPositionRow
    | undefined;
}

export function insertPosition(row: ManualPositionRow): void {
  getDb()
    .prepare(
      `INSERT INTO manual_positions (position_id, account_id, symbol, name, asset_type, quantity, book_cost, manual_value, currency, effective_date, end_date, created_at)
       VALUES (@position_id, @account_id, @symbol, @name, @asset_type, @quantity, @book_cost, @manual_value, @currency, @effective_date, @end_date, @created_at)`,
    )
    .run(row);
}

/** Close a position row as of `endDate` (versioned edit / sell-out). */
export function closePosition(positionId: string, endDate: string): boolean {
  return (
    getDb()
      .prepare(`UPDATE manual_positions SET end_date = ? WHERE position_id = ? AND end_date IS NULL`)
      .run(endDate, positionId).changes > 0
  );
}

/** Positions in effect on `date` (effective_date <= date < end_date). */
export function positionsAsOf(date: string): ManualPositionRow[] {
  return getDb()
    .prepare(
      `SELECT p.* FROM manual_positions p
       JOIN accounts a ON a.account_id = p.account_id
       WHERE a.tracked = 1 AND p.effective_date <= ? AND (p.end_date IS NULL OR p.end_date > ?)`,
    )
    .all(date, date) as ManualPositionRow[];
}

/** Earliest effective date across all positions (snapshot rebuild horizon). */
export function earliestPositionDate(): string | null {
  const row = getDb().prepare(`SELECT MIN(effective_date) AS d FROM manual_positions`).get() as { d: string | null };
  return row.d;
}

/** Distinct market symbols currently or historically held. */
export function positionSymbols(): string[] {
  return (
    getDb()
      .prepare(`SELECT DISTINCT symbol FROM manual_positions WHERE symbol IS NOT NULL`)
      .all() as { symbol: string }[]
  ).map((r) => r.symbol);
}

/** Distinct symbols of currently-held positions with their asset type — the
 *  intraday job uses the type to decide market-hours eligibility. */
export function activePositionSymbols(): { symbol: string; asset_type: ManualPositionRow["asset_type"] }[] {
  return getDb()
    .prepare(
      `SELECT DISTINCT p.symbol AS symbol, p.asset_type AS asset_type FROM manual_positions p
       JOIN accounts a ON a.account_id = p.account_id
       WHERE a.tracked = 1 AND p.symbol IS NOT NULL AND p.end_date IS NULL`,
    )
    .all() as { symbol: string; asset_type: ManualPositionRow["asset_type"] }[];
}

/** True when any active position is held in a non-CAD currency (needs FX). */
export function hasNonCadPositions(): boolean {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM manual_positions WHERE end_date IS NULL AND currency IS NOT NULL AND currency != 'CAD'`)
    .get() as { n: number };
  return row.n > 0;
}

export function latestPriceDate(securityId: string): string | null {
  const row = getDb()
    .prepare(`SELECT MAX(date) AS d FROM security_prices WHERE security_id = ?`)
    .get(securityId) as { d: string | null };
  return row.d;
}

/** Prices for a set of securities in a range, for snapshot building. */
export function pricesRange(range: { start: string; end: string }): Map<string, { date: string; close: number; currency: string }[]> {
  const rows = getDb()
    .prepare(`SELECT security_id, date, close_price, currency FROM security_prices WHERE date >= ? AND date <= ? ORDER BY date`)
    .all(range.start, range.end) as { security_id: string; date: string; close_price: number; currency: string }[];
  const out = new Map<string, { date: string; close: number; currency: string }[]>();
  for (const r of rows) {
    const list = out.get(r.security_id) ?? [];
    list.push({ date: r.date, close: r.close_price, currency: r.currency });
    out.set(r.security_id, list);
  }
  return out;
}

export function invTxRange(
  range: { start: string; end: string },
  types?: string[],
): (InvestmentTxRow & { person_id: string | null })[] {
  const typeFilter = types && types.length > 0 ? `AND t.tx_type IN (${types.map(() => "?").join(",")})` : "";
  return getDb()
    .prepare(
      `SELECT t.*, a.person_id FROM investment_transactions t
       JOIN accounts a ON a.account_id = t.account_id
       WHERE a.tracked = 1 AND t.date >= ? AND t.date <= ? ${typeFilter}
       ORDER BY t.date`,
    )
    .all(range.start, range.end, ...(types ?? [])) as (InvestmentTxRow & { person_id: string | null })[];
}
