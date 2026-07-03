/**
 * analytics/portfolio.ts — investment performance and allocation. Pure.
 * External-flow convention: positive = cash INTO the portfolio from outside
 * (contribution, dividend kept in cash, transfer-in); negative = out.
 */
import type { DateISO, Lens, MonthISO, TimePoint } from "./types.js";
import { monthOf } from "./calendar.js";
import { roundCents } from "./money.js";
import { inLens } from "./cashflow.js";

export interface HoldingPoint {
  accountId: string;
  personId: string | null;
  securityId: string;
  date: DateISO;
  quantity: number;
  value: number;
  costBasis: number | null;
}

export interface SecurityMeta {
  securityId: string;
  ticker: string | null;
  name: string | null;
  secType: string | null;
}

export interface ExternalFlow {
  date: DateISO;
  amount: number;
}

/** Total portfolio value per snapshot date (holdings are snapshotted daily). */
export function portfolioSeries(holdings: HoldingPoint[], lens: Lens): TimePoint[] {
  const byDate = new Map<string, number>();
  for (const h of holdings) {
    if (!inLens(h.personId, lens)) continue;
    byDate.set(h.date, (byDate.get(h.date) ?? 0) + h.value);
  }
  return [...byDate.entries()]
    .map(([date, value]) => ({ date, value: roundCents(value) }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

export interface Decomposition {
  /** Cumulative net external contributions, aligned with `dates`. */
  contributions: TimePoint[];
  /** value − startValue − cumulative contributions: the market's share. */
  growth: TimePoint[];
}

/** The honest chart: how much of the curve is your money vs. the market's. */
export function contributionVsGrowth(series: TimePoint[], flows: ExternalFlow[]): Decomposition {
  const sorted = [...flows].sort((a, b) => (a.date < b.date ? -1 : 1));
  const startValue = series[0]?.value ?? 0;
  const contributions: TimePoint[] = [];
  const growth: TimePoint[] = [];
  let cum = 0;
  let fi = 0;
  for (const p of series) {
    while (fi < sorted.length && sorted[fi]!.date <= p.date) {
      cum += sorted[fi]!.amount;
      fi++;
    }
    contributions.push({ date: p.date, value: roundCents(cum) });
    growth.push({ date: p.date, value: roundCents(p.value - startValue - cum) });
  }
  return { contributions, growth };
}

/** Time-weighted return via daily linking with flow adjustment. */
export function timeWeightedReturn(series: TimePoint[], flows: ExternalFlow[]): number | null {
  if (series.length < 2) return null;
  const flowByDate = new Map<string, number>();
  for (const f of flows) flowByDate.set(f.date, (flowByDate.get(f.date) ?? 0) + f.amount);
  let twr = 1;
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1]!.value;
    const flow = flowByDate.get(series[i]!.date) ?? 0;
    const base = prev + flow;
    if (base <= 0) continue;
    twr *= series[i]!.value / base;
  }
  return Math.round((twr - 1) * 10000) / 10000;
}

/**
 * Money-weighted return (annualized XIRR) via bisection. Investor
 * perspective: start value and contributions are money in (negative cash
 * flows), the ending value is the payoff.
 */
export function moneyWeightedReturn(series: TimePoint[], flows: ExternalFlow[]): number | null {
  const first = series[0];
  const last = series[series.length - 1];
  if (!first || !last || first.date === last.date) return null;

  const cashflows: { t: number; amount: number }[] = [];
  const t0 = new Date(first.date).getTime();
  const years = (d: string) => (new Date(d).getTime() - t0) / (365.25 * 86_400_000);
  cashflows.push({ t: 0, amount: -first.value });
  for (const f of flows) {
    if (f.date <= first.date || f.date > last.date) continue;
    cashflows.push({ t: years(f.date), amount: -f.amount });
  }
  cashflows.push({ t: years(last.date), amount: last.value });

  const npv = (rate: number) => cashflows.reduce((s, c) => s + c.amount / Math.pow(1 + rate, c.t), 0);
  let lo = -0.95;
  let hi = 10;
  if (npv(lo) * npv(hi) > 0) return null;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (npv(lo) * npv(mid) <= 0) hi = mid;
    else lo = mid;
  }
  return Math.round(((lo + hi) / 2) * 10000) / 10000;
}

export interface AllocationSlice {
  class: string;
  value: number;
  weight: number;
  target: number | null;
  drift: number | null;
}

const CLASS_MAP: Record<string, string> = {
  equity: "equity",
  etf: "equity",
  "mutual fund": "equity",
  "fixed income": "fixed_income",
  cash: "cash",
  cryptocurrency: "crypto",
  crypto: "crypto",
};

/** Latest-date allocation by asset class, with drift vs. targets (weights 0–1). */
export function allocation(
  holdings: HoldingPoint[],
  securities: SecurityMeta[],
  targets: Record<string, number> | null,
  lens: Lens,
): AllocationSlice[] {
  const latestDate = holdings.reduce((max, h) => (h.date > max ? h.date : max), "");
  const secById = new Map(securities.map((s) => [s.securityId, s]));
  const byClass = new Map<string, number>();
  let total = 0;
  for (const h of holdings) {
    if (h.date !== latestDate || !inLens(h.personId, lens)) continue;
    const secType = secById.get(h.securityId)?.secType?.toLowerCase() ?? "other";
    const cls = CLASS_MAP[secType] ?? "other";
    byClass.set(cls, (byClass.get(cls) ?? 0) + h.value);
    total += h.value;
  }
  return [...byClass.entries()]
    .map(([cls, value]) => {
      const weight = total > 0 ? Math.round((value / total) * 1000) / 1000 : 0;
      const target = targets?.[cls] ?? null;
      return {
        class: cls,
        value: roundCents(value),
        weight,
        target,
        drift: target !== null ? Math.round((weight - target) * 1000) / 1000 : null,
      };
    })
    .sort((a, b) => b.value - a.value);
}

/** Dividend/interest income by month. */
export function dividendIncome(
  invTx: { date: DateISO; txType: string; amount: number; personId: string | null }[],
  lens: Lens,
): { month: MonthISO; value: number }[] {
  const byMonth = new Map<string, number>();
  for (const tx of invTx) {
    if (tx.txType !== "dividend" && tx.txType !== "interest") continue;
    if (!inLens(tx.personId, lens)) continue;
    const m = monthOf(tx.date);
    byMonth.set(m, (byMonth.get(m) ?? 0) + Math.abs(tx.amount));
  }
  return [...byMonth.entries()]
    .map(([month, value]) => ({ month, value: roundCents(value) }))
    .sort((a, b) => (a.month < b.month ? -1 : 1));
}
