/**
 * engine/portfolioService.ts — Investments page payloads.
 */
import {
  addDays,
  allocation,
  contributionVsGrowth,
  dividendIncome,
  moneyWeightedReturn,
  portfolioSeries,
  roundCents,
  timeWeightedReturn,
  inLens,
  type AllocationSlice,
  type Decomposition,
  type TimePoint,
} from "../analytics/index.js";
import type { EngineContext } from "./context.js";
import {
  bankFlowsForInvestmentAccounts,
  holdingsRange,
  invTxRange,
  listSecurities,
  toSecurityMeta,
} from "../db/repositories/investments.js";
import {
  createManualAsset,
  listManualAssets,
  addValuation,
  valuations,
  type ManualAssetRow,
} from "../db/repositories/history.js";
import { getSetting, setSetting } from "../db/repositories/ops.js";
import { flowsForRange, listCategories, toCategoryNode } from "../db/repositories/budgeting.js";

const EXTERNAL_TYPES = ["contribution", "withdrawal", "transfer"];

/**
 * External flows = investment-transaction rows (if any source provides them)
 * plus bank-rail transactions on investment accounts (the manual-positions
 * world: deposits/withdrawals cross the bank ledger, trades don't).
 */
function externalFlows(range: { start: string; end: string }, lens: string) {
  const fromInvTx = invTxRange(range, EXTERNAL_TYPES)
    .filter((t) => inLens(t.person_id, lens))
    .map((t) => ({ date: t.date, amount: t.amount }));
  const fromBank = bankFlowsForInvestmentAccounts(range)
    .filter((t) => inLens(t.person_id, lens))
    .map((t) => ({ date: t.date, amount: t.amount }));
  return [...fromInvTx, ...fromBank].sort((a, b) => (a.date < b.date ? -1 : 1));
}

export interface PortfolioSeriesResponse {
  series: TimePoint[];
  decomposition: Decomposition | null;
}

export function getPortfolioSeries(ctx: EngineContext, days: number, decompose: boolean): PortfolioSeriesResponse {
  const range = { start: addDays(ctx.today, -days), end: ctx.today };
  const series = portfolioSeries(holdingsRange(range), ctx.lens);
  return {
    series,
    decomposition: decompose && series.length > 0 ? contributionVsGrowth(series, externalFlows(range, ctx.lens)) : null,
  };
}

export interface HoldingRowOut {
  securityId: string;
  ticker: string | null;
  name: string | null;
  secType: string | null;
  quantity: number;
  value: number;
  costBasis: number | null;
  gain: number | null;
  weight: number;
  spark30d: TimePoint[];
}

export function getHoldings(ctx: EngineContext): HoldingRowOut[] {
  const range = { start: addDays(ctx.today, -35), end: ctx.today };
  const holdings = holdingsRange(range).filter((h) => inLens(h.personId, ctx.lens));
  if (holdings.length === 0) return [];
  const latestDate = holdings.reduce((max, h) => (h.date > max ? h.date : max), "");
  const secMeta = new Map(listSecurities().map((s) => [s.security_id, toSecurityMeta(s)]));

  const bySecurity = new Map<string, typeof holdings>();
  for (const h of holdings) {
    const list = bySecurity.get(h.securityId) ?? [];
    list.push(h);
    bySecurity.set(h.securityId, list);
  }
  const latest = [...bySecurity.entries()].map(([securityId, rows]) => {
    const today = rows.filter((r) => r.date === latestDate);
    const value = today.reduce((s, r) => s + r.value, 0);
    const quantity = today.reduce((s, r) => s + r.quantity, 0);
    const cost = today.every((r) => r.costBasis !== null) ? today.reduce((s, r) => s + (r.costBasis ?? 0), 0) : null;
    const sparkMap = new Map<string, number>();
    for (const r of rows) sparkMap.set(r.date, (sparkMap.get(r.date) ?? 0) + r.value);
    return {
      securityId,
      quantity,
      value: roundCents(value),
      costBasis: cost !== null ? roundCents(cost) : null,
      spark30d: [...sparkMap.entries()].map(([date, v]) => ({ date, value: roundCents(v) })).sort((a, b) => (a.date < b.date ? -1 : 1)),
    };
  });
  const total = latest.reduce((s, h) => s + h.value, 0);
  return latest
    .filter((h) => h.value > 0)
    .map((h) => {
      const meta = secMeta.get(h.securityId);
      return {
        securityId: h.securityId,
        ticker: meta?.ticker ?? null,
        name: meta?.name ?? null,
        secType: meta?.secType ?? null,
        quantity: h.quantity,
        value: h.value,
        costBasis: h.costBasis,
        gain: h.costBasis !== null ? roundCents(h.value - h.costBasis) : null,
        weight: total > 0 ? Math.round((h.value / total) * 1000) / 1000 : 0,
        spark30d: h.spark30d,
      };
    })
    .sort((a, b) => b.value - a.value);
}

export function getAllocation(ctx: EngineContext): AllocationSlice[] {
  const range = { start: addDays(ctx.today, -7), end: ctx.today };
  const targetsRaw = getSetting("allocation_targets");
  const targets = targetsRaw ? (JSON.parse(targetsRaw) as Record<string, number>) : null;
  return allocation(holdingsRange(range), listSecurities().map(toSecurityMeta), targets, ctx.lens);
}

export function setAllocationTargets(targets: Record<string, number>): void {
  setSetting("allocation_targets", JSON.stringify(targets));
}

export interface PerformanceResponse {
  twr: number | null;
  mwr: number | null;
  dividendsByMonth: { month: string; value: number }[];
}

export function getPerformance(ctx: EngineContext, days: number): PerformanceResponse {
  const range = { start: addDays(ctx.today, -days), end: ctx.today };
  const series = portfolioSeries(holdingsRange(range), ctx.lens);
  const flows = externalFlows(range, ctx.lens);
  const divs = invTxRange(range, ["dividend", "interest"]).map((t) => ({
    date: t.date,
    txType: t.tx_type,
    amount: t.amount,
    personId: t.person_id,
  }));
  return {
    twr: timeWeightedReturn(series, flows),
    mwr: moneyWeightedReturn(series, flows),
    dividendsByMonth: dividendIncome(divs, ctx.lens),
  };
}

// ---- manual assets (incl. the Buildings P&L) ----

export interface ManualAssetOut extends ManualAssetRow {
  valuations: { date: string; value: number; source: string | null }[];
}

export function getManualAssets(): ManualAssetOut[] {
  return listManualAssets().map((a) => ({ ...a, valuations: valuations(a.asset_id) }));
}

export function addManualAsset(input: {
  name: string;
  assetClass: ManualAssetRow["asset_class"];
  personId?: string | null;
  currency?: string;
  notes?: string | null;
  initialValue?: number;
  today: string;
}): ManualAssetOut {
  const row = createManualAsset({
    person_id: input.personId ?? null,
    name: input.name,
    asset_class: input.assetClass,
    currency: input.currency ?? "CAD",
    notes: input.notes ?? null,
  });
  if (input.initialValue !== undefined) addValuation(row.asset_id, input.today, input.initialValue, "initial");
  return { ...row, valuations: valuations(row.asset_id) };
}

export function revalueAsset(assetId: string, date: string, value: number, source: string | null): void {
  addValuation(assetId, date, value, source);
}

export interface BuildingsPnl {
  asset: ManualAssetOut | null;
  incomeByMonth: { month: string; value: number }[];
  expensesByMonth: { month: string; value: number }[];
  netByMonth: { month: string; value: number }[];
}

/** Rental mini-P&L: 'Buildings' income category vs. buildings-reimbursed expenses. */
export function getBuildingsPnl(ctx: EngineContext, months = 12): BuildingsPnl {
  const start = `${ctx.month.slice(0, 7)}-01`;
  const range = { start: addDays(start, -months * 31), end: ctx.range.end };
  const categories = listCategories().map(toCategoryNode);
  const buildingsCat = categories.find((c) => c.name.toLowerCase() === "buildings");
  const flows = flowsForRange(range);

  const income = new Map<string, number>();
  const expenses = new Map<string, number>();
  for (const tx of flows) {
    const month = tx.date.slice(0, 7);
    if (buildingsCat && tx.categoryId === buildingsCat.categoryId) {
      income.set(month, (income.get(month) ?? 0) + -tx.amount);
    } else if (tx.reimbursedBy === "buildings") {
      expenses.set(month, (expenses.get(month) ?? 0) + tx.amount);
    }
  }
  const monthsList = [...new Set([...income.keys(), ...expenses.keys()])].sort();
  const asset = getManualAssets().find((a) => a.name.toLowerCase().includes("building")) ?? null;
  return {
    asset,
    incomeByMonth: monthsList.map((m) => ({ month: m, value: roundCents(income.get(m) ?? 0) })),
    expensesByMonth: monthsList.map((m) => ({ month: m, value: roundCents(expenses.get(m) ?? 0) })),
    netByMonth: monthsList.map((m) => ({ month: m, value: roundCents((income.get(m) ?? 0) - (expenses.get(m) ?? 0)) })),
  };
}
