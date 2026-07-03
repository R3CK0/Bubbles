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
  asset_type: "stock" | "etf" | "crypto" | "option" | "cash" | "other";
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
