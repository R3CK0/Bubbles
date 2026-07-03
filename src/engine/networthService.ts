/**
 * engine/networthService.ts — Net Worth page + Overview hero.
 */
import {
  addDays,
  addMonths,
  breakdownAt,
  computeCashflow,
  emergencyFundMonths,
  milestones,
  monthWindow,
  netWorthSeries,
  roundCents,
  type BreakdownEntry,
  type Milestone,
  type NetWorthSeries,
} from "../analytics/index.js";
import type { EngineContext } from "./context.js";
import { getDb } from "../db/db.js";
import { allValuations, listManualAssets, snapshotRange } from "../db/repositories/history.js";
import { listDebts } from "../db/repositories/debts.js";
import { flowsForRange, listCategories, toCategoryNode } from "../db/repositories/budgeting.js";

interface NetWorthInputs {
  snapshots: ReturnType<typeof mapSnapshots>;
  accounts: { accountId: string; personId: string | null; type: string | null; name: string | null }[];
  valuations: { assetId: string; personId: string | null; name: string; date: string; value: number }[];
  manualDebts: { debtId: string; personId: string | null; name: string; balance: number }[];
}

function mapSnapshots(range: { start: string; end: string }) {
  return snapshotRange(range)
    .filter((s) => s.current_balance !== null)
    .map((s) => ({ accountId: s.account_id, date: s.date, balance: s.current_balance! }));
}

function loadInputs(range: { start: string; end: string }): NetWorthInputs {
  const accounts = (
    getDb()
      .prepare(`SELECT account_id, person_id, type, name FROM accounts WHERE tracked = 1`)
      .all() as { account_id: string; person_id: string | null; type: string | null; name: string | null }[]
  ).map((a) => ({ accountId: a.account_id, personId: a.person_id, type: a.type, name: a.name }));

  const assets = listManualAssets();
  const assetMeta = new Map(assets.map((a) => [a.asset_id, a]));
  const valuations = allValuations()
    .filter((v) => assetMeta.has(v.asset_id))
    .map((v) => {
      const meta = assetMeta.get(v.asset_id)!;
      return { assetId: v.asset_id, personId: meta.person_id, name: meta.name, date: v.date, value: v.value };
    });

  // Debts without a linked account (linked ones appear via account balances).
  const manualDebts = listDebts("active")
    .filter((d) => d.account_id === null)
    .map((d) => ({ debtId: d.debt_id, personId: d.person_id, name: d.name, balance: d.current_balance }));

  return { snapshots: mapSnapshots(range), accounts, valuations, manualDebts };
}

export interface NetWorthResponse extends NetWorthSeries {
  milestones: Milestone[];
}

export function getNetWorth(ctx: EngineContext, days = 365): NetWorthResponse {
  const range = { start: addDays(ctx.today, -days), end: ctx.today };
  const inputs = loadInputs(range);
  const series = netWorthSeries(inputs.snapshots, inputs.accounts, inputs.valuations, inputs.manualDebts, ctx.lens);
  return { ...series, milestones: milestones(series.net) };
}

export interface HeroResponse {
  current: number;
  monthDelta: number | null;
  spark90d: { date: string; value: number }[];
  lastMilestone: Milestone | null;
}

export function getHero(ctx: EngineContext): HeroResponse {
  const range = { start: addDays(ctx.today, -90), end: ctx.today };
  const inputs = loadInputs(range);
  const series = netWorthSeries(inputs.snapshots, inputs.accounts, inputs.valuations, inputs.manualDebts, ctx.lens);
  const current = series.net[series.net.length - 1]?.value ?? 0;
  const monthAgo = series.net.find((p) => p.date >= addDays(ctx.today, -30));
  const flags = milestones(series.net);
  return {
    current,
    monthDelta: monthAgo ? roundCents(current - monthAgo.value) : null,
    spark90d: series.net,
    lastMilestone: flags[flags.length - 1] ?? null,
  };
}

export function getBreakdown(ctx: EngineContext, date: string): BreakdownEntry[] {
  const range = { start: addDays(date, -400), end: date };
  const inputs = loadInputs(range);
  return breakdownAt(date, inputs.snapshots, inputs.accounts, inputs.valuations, inputs.manualDebts, ctx.lens);
}

export interface EmergencyFundResponse {
  liquidBalance: number;
  essentialsMonthlyAvg: number;
  months: number | null;
}

/** Liquid = depository balances; essentials = trailing 3-month average. */
export function getEmergencyFund(ctx: EngineContext): EmergencyFundResponse {
  const liquid = (
    getDb()
      .prepare(
        `SELECT COALESCE(SUM(current_balance), 0) AS s FROM accounts WHERE tracked = 1 AND is_closed = 0 AND type = 'depository'`,
      )
      .get() as { s: number }
  ).s;

  const categories = listCategories().map(toCategoryNode);
  const essentialIds = new Set(
    categories.filter((c) => c.parentId === "essentials" || c.categoryId === "essentials").map((c) => c.categoryId),
  );
  let total = 0;
  for (let i = 1; i <= 3; i++) {
    const window = monthWindow(addMonths(ctx.month, -i));
    const summary = computeCashflow(flowsForRange(window), categories, ctx.lens, window);
    total += summary.byCategory
      .filter((c) => c.categoryId !== null && essentialIds.has(c.categoryId))
      .reduce((s, c) => s + c.amount, 0);
  }
  const essentialsMonthlyAvg = roundCents(total / 3);
  return {
    liquidBalance: roundCents(liquid),
    essentialsMonthlyAvg,
    months: emergencyFundMonths(liquid, essentialsMonthlyAvg),
  };
}
