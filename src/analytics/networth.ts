/**
 * analytics/networth.ts — the headline number over time. Pure.
 * Balances carry forward per source between observations; liability accounts
 * (credit/loan) and manual debts fold into the mirrored negative band.
 */
import type { DateISO, Lens, TimePoint } from "./types.js";
import { inLens } from "./cashflow.js";
import { roundCents } from "./money.js";

export interface SnapshotPoint {
  accountId: string;
  date: DateISO;
  balance: number;
}

export interface AccountMeta {
  accountId: string;
  personId: string | null;
  /** Plaid account type: depository / investment / credit / loan / other. */
  type: string | null;
  name: string | null;
}

export interface ValuationPoint {
  assetId: string;
  personId: string | null;
  name: string;
  date: DateISO;
  value: number;
}

export interface ManualDebtInput {
  debtId: string;
  personId: string | null;
  name: string;
  balance: number;
}

export interface NetWorthSeries {
  dates: DateISO[];
  assets: TimePoint[];
  debts: TimePoint[];
  net: TimePoint[];
}

const LIABILITY_TYPES = new Set(["credit", "loan"]);

function isLiability(meta: AccountMeta | undefined): boolean {
  return meta !== undefined && meta.type !== null && LIABILITY_TYPES.has(meta.type);
}

/**
 * Daily net worth from account snapshots + manual-asset valuations + manual
 * debts (debts without a linked account; linked ones already appear as
 * account balances). Dates = union of observation dates, carry-forward.
 */
export function netWorthSeries(
  snapshots: SnapshotPoint[],
  accounts: AccountMeta[],
  valuations: ValuationPoint[],
  manualDebts: ManualDebtInput[],
  lens: Lens,
): NetWorthSeries {
  const metaById = new Map(accounts.map((a) => [a.accountId, a]));
  const inScope = (personId: string | null) => inLens(personId, lens);

  const dates = [...new Set([...snapshots.map((s) => s.date), ...valuations.map((v) => v.date)])].sort();
  if (dates.length === 0) return { dates: [], assets: [], debts: [], net: [] };

  // Observations per source, sorted by date, walked with carry-forward.
  const bySource = new Map<string, { dates: DateISO[]; values: number[]; liability: boolean }>();
  for (const s of snapshots) {
    const meta = metaById.get(s.accountId);
    if (!meta || !inScope(meta.personId)) continue;
    const src = bySource.get(s.accountId) ?? { dates: [], values: [], liability: isLiability(meta) };
    src.dates.push(s.date);
    src.values.push(Math.abs(s.balance));
    bySource.set(s.accountId, src);
  }
  for (const v of valuations) {
    if (!inScope(v.personId)) continue;
    const key = `asset:${v.assetId}`;
    const src = bySource.get(key) ?? { dates: [], values: [], liability: false };
    src.dates.push(v.date);
    src.values.push(v.value);
    bySource.set(key, src);
  }

  const manualDebtTotal = manualDebts
    .filter((d) => inScope(d.personId))
    .reduce((s, d) => s + d.balance, 0);

  const cursors = new Map<string, number>();
  const assets: TimePoint[] = [];
  const debts: TimePoint[] = [];
  const net: TimePoint[] = [];
  for (const date of dates) {
    let assetTotal = 0;
    let debtTotal = manualDebtTotal;
    for (const [key, src] of bySource) {
      let i = cursors.get(key) ?? -1;
      while (i + 1 < src.dates.length && src.dates[i + 1]! <= date) i++;
      cursors.set(key, i);
      if (i < 0) continue; // not observed yet
      const value = src.values[i]!;
      if (src.liability) debtTotal += value;
      else assetTotal += value;
    }
    assets.push({ date, value: roundCents(assetTotal) });
    debts.push({ date, value: roundCents(debtTotal) });
    net.push({ date, value: roundCents(assetTotal - debtTotal) });
  }
  return { dates, assets, debts, net };
}

export interface Milestone {
  date: DateISO;
  value: number;
}

/** Upward crossings of each `step` boundary (the gold flags). */
export function milestones(net: TimePoint[], step = 25_000): Milestone[] {
  const out: Milestone[] = [];
  let prevTier = net.length > 0 ? Math.floor(net[0]!.value / step) : 0;
  for (const p of net.slice(1)) {
    const tier = Math.floor(p.value / step);
    if (tier > prevTier) out.push({ date: p.date, value: tier * step });
    prevTier = Math.max(prevTier, tier);
  }
  return out;
}

export interface BreakdownEntry {
  label: string;
  value: number;
  kind: "account" | "manual_asset" | "manual_debt";
  liability: boolean;
}

/** Composition at (or nearest before) `date` for the hover panel. */
export function breakdownAt(
  date: DateISO,
  snapshots: SnapshotPoint[],
  accounts: AccountMeta[],
  valuations: ValuationPoint[],
  manualDebts: ManualDebtInput[],
  lens: Lens,
): BreakdownEntry[] {
  const metaById = new Map(accounts.map((a) => [a.accountId, a]));
  const out: BreakdownEntry[] = [];

  const latestPer = new Map<string, SnapshotPoint>();
  for (const s of snapshots) {
    if (s.date > date) continue;
    const prev = latestPer.get(s.accountId);
    if (!prev || prev.date < s.date) latestPer.set(s.accountId, s);
  }
  for (const [accountId, snap] of latestPer) {
    const meta = metaById.get(accountId);
    if (!meta || !inLens(meta.personId, lens)) continue;
    out.push({
      label: meta.name ?? accountId,
      value: roundCents(Math.abs(snap.balance)),
      kind: "account",
      liability: isLiability(meta),
    });
  }
  const latestVal = new Map<string, ValuationPoint>();
  for (const v of valuations) {
    if (v.date > date || !inLens(v.personId, lens)) continue;
    const prev = latestVal.get(v.assetId);
    if (!prev || prev.date < v.date) latestVal.set(v.assetId, v);
  }
  for (const v of latestVal.values()) {
    out.push({ label: v.name, value: roundCents(v.value), kind: "manual_asset", liability: false });
  }
  for (const d of manualDebts) {
    if (!inLens(d.personId, lens)) continue;
    out.push({ label: d.name, value: roundCents(d.balance), kind: "manual_debt", liability: true });
  }
  return out.sort((a, b) => b.value - a.value);
}

/** Months of essentials covered by liquid balances (the gauge). */
export function emergencyFundMonths(liquidBalance: number, essentialsMonthlyAvg: number): number | null {
  if (essentialsMonthlyAvg <= 0) return null;
  return Math.round((liquidBalance / essentialsMonthlyAvg) * 10) / 10;
}
