/**
 * analytics/money.ts — money math discipline. Pure.
 * Doubles internally, cents at every function boundary (see DATA_MODEL.md).
 */
import type { DateISO, FlowTx, FxRate } from "./types.js";

export function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Engine sign convention: inflow > 0. Plaid stores positive-for-outflow, so
 * this negation happens in exactly one place.
 */
export function signedFlow(tx: Pick<FlowTx, "amount">): number {
  return -tx.amount;
}

/**
 * FX lookup table: pair key `${base}/${quote}` → rows sorted by date asc.
 * Build once per request from fx_rates rows.
 */
export type FxTable = Map<string, { date: DateISO; rate: number }[]>;

export function buildFxTable(rows: FxRate[]): FxTable {
  const table: FxTable = new Map();
  for (const r of rows) {
    const key = `${r.baseCcy}/${r.quoteCcy}`;
    const list = table.get(key) ?? [];
    list.push({ date: r.date, rate: r.rate });
    table.set(key, list);
  }
  for (const list of table.values()) list.sort((a, b) => (a.date < b.date ? -1 : 1));
  return table;
}

/**
 * Convert to CAD at the rate on `date`, carrying the nearest earlier rate
 * forward across weekends/holidays (or the earliest rate when `date` predates
 * the table). Unknown currency pairs throw — silent 1:1 would corrupt totals.
 */
export function toCAD(amount: number, currency: string | null, date: DateISO, fx: FxTable): number {
  if (!currency || currency === "CAD") return roundCents(amount);
  const list = fx.get(`${currency}/CAD`);
  if (!list || list.length === 0) throw new Error(`no FX rates for ${currency}/CAD`);
  let rate = list[0]!.rate;
  for (const row of list) {
    if (row.date > date) break;
    rate = row.rate;
  }
  return roundCents(amount * rate);
}

export function sumBy<T>(rows: T[], f: (row: T) => number): number {
  let total = 0;
  for (const r of rows) total += f(r);
  return roundCents(total);
}

export function groupSum<T>(rows: T[], key: (row: T) => string, f: (row: T) => number): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const k = key(r);
    out.set(k, (out.get(k) ?? 0) + f(r));
  }
  for (const [k, v] of out) out.set(k, roundCents(v));
  return out;
}
