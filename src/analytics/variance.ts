/**
 * analytics/variance.ts — budget vs. actual and why it moved. Pure.
 */
import type { CategoryNode, FlowTx, Lens } from "./types.js";
import { COMBINED } from "./types.js";
import { groupSum, roundCents, signedFlow } from "./money.js";

export interface BudgetLineInput {
  categoryId: string;
  personId: string | null;
  monthlyAmount: number;
}

export interface BudgetVsActualRow {
  categoryId: string;
  name: string;
  kind: CategoryNode["kind"];
  parentId: string | null;
  budget: number;
  actual: number;
  /** actual − budget: positive = overspent (or over-earned for income). */
  variance: number;
  /**
   * actual ÷ (budget × elapsed fraction of the month); > 1 means spending
   * faster than the month allows. NaN-safe: null when budget is 0.
   */
  pace: number | null;
}

/** Sum budget lines under the lens (person lines + joint lines). */
function lensBudget(lines: BudgetLineInput[], categoryId: string, lens: Lens): number {
  let total = 0;
  for (const line of lines) {
    if (line.categoryId !== categoryId) continue;
    if (lens !== COMBINED && line.personId !== null && line.personId !== lens) continue;
    total += line.monthlyAmount;
  }
  return roundCents(total);
}

/**
 * One row per category that has a budget line or actual activity.
 * `actualsByCategory` uses absolute amounts (spend positive), keyed by
 * categoryId — computeCashflow().byCategory reshaped by the service.
 * `dayFraction` is elapsed-days/days-in-month for the viewed month (1 for
 * past months).
 */
export function budgetVsActual(
  lines: BudgetLineInput[],
  actualsByCategory: Map<string, number>,
  categories: CategoryNode[],
  lens: Lens,
  dayFraction: number,
): BudgetVsActualRow[] {
  const index = new Map(categories.map((c) => [c.categoryId, c]));
  const ids = new Set<string>([
    ...lines.map((l) => l.categoryId),
    ...actualsByCategory.keys(),
  ]);

  const rows: BudgetVsActualRow[] = [];
  for (const categoryId of ids) {
    const cat = index.get(categoryId);
    if (!cat || cat.kind === "transfer") continue;
    const budget = lensBudget(lines, categoryId, lens);
    const actual = roundCents(actualsByCategory.get(categoryId) ?? 0);
    const expected = budget * dayFraction;
    rows.push({
      categoryId,
      name: cat.name,
      kind: cat.kind,
      parentId: cat.parentId,
      budget,
      actual,
      variance: roundCents(actual - budget),
      pace: expected > 0 ? roundCents(actual / expected) : null,
    });
  }
  return rows.sort((a, b) => b.variance - a.variance);
}

/** Average actual per category across the supplied months of transactions. */
export function rollingBaseline(txsByMonth: Map<string, FlowTx[]>): Map<string, number> {
  const months = txsByMonth.size;
  if (months === 0) return new Map();
  const totals = new Map<string, number>();
  for (const txs of txsByMonth.values()) {
    for (const tx of txs) {
      const key = tx.categoryId ?? "uncategorized";
      totals.set(key, (totals.get(key) ?? 0) + Math.abs(signedFlow(tx)));
    }
  }
  for (const [k, v] of totals) totals.set(k, roundCents(v / months));
  return totals;
}

export type DriverKind = "new_merchant" | "price_increase" | "frequency_increase" | "one_off";

export interface VarianceDriver {
  kind: DriverKind;
  merchant: string;
  delta: number;
  detail: string;
}

function merchantKey(tx: FlowTx): string {
  return (tx.merchantName ?? tx.payee ?? "unknown").toLowerCase();
}

/**
 * Deterministic decomposition of why current-period spend differs from the
 * baseline period, by merchant. Baseline amounts are normalized per month via
 * `baselineMonths` so a 3-month baseline compares against 1 current month.
 */
export function decomposeVariance(
  currentTx: FlowTx[],
  baselineTx: FlowTx[],
  baselineMonths: number,
): VarianceDriver[] {
  const spend = (t: FlowTx) => Math.max(0, -signedFlow(t));
  const curByMerchant = groupSum(currentTx, merchantKey, spend);
  const curCounts = new Map<string, number>();
  for (const t of currentTx) curCounts.set(merchantKey(t), (curCounts.get(merchantKey(t)) ?? 0) + 1);

  const baseByMerchant = groupSum(baselineTx, merchantKey, spend);
  const baseCounts = new Map<string, number>();
  for (const t of baselineTx) baseCounts.set(merchantKey(t), (baseCounts.get(merchantKey(t)) ?? 0) + 1);

  const drivers: VarianceDriver[] = [];
  for (const [merchant, curAmount] of curByMerchant) {
    if (curAmount <= 0) continue;
    const baseAmount = (baseByMerchant.get(merchant) ?? 0) / Math.max(1, baselineMonths);
    const curCount = curCounts.get(merchant) ?? 0;
    const baseCount = (baseCounts.get(merchant) ?? 0) / Math.max(1, baselineMonths);
    const delta = roundCents(curAmount - baseAmount);
    if (delta <= 0.01) continue;

    if (baseAmount === 0) {
      const kind = curCount === 1 && curAmount >= 100 ? "one_off" : "new_merchant";
      drivers.push({
        kind,
        merchant,
        delta,
        detail:
          kind === "one_off"
            ? `single ${curAmount.toFixed(2)} charge, not seen before`
            : `new merchant: ${curAmount.toFixed(2)} this period`,
      });
      continue;
    }
    const avgCur = curAmount / Math.max(1, curCount);
    const avgBase = baseAmount / Math.max(1, baseCount || 1);
    if (curCount > baseCount * 1.5 && curCount - baseCount >= 1) {
      drivers.push({
        kind: "frequency_increase",
        merchant,
        delta,
        detail: `${curCount} charges vs ~${baseCount.toFixed(1)}/period before`,
      });
    } else if (avgCur > avgBase * 1.05) {
      drivers.push({
        kind: "price_increase",
        merchant,
        delta,
        detail: `avg ${avgCur.toFixed(2)} vs ${avgBase.toFixed(2)} before`,
      });
    } else {
      drivers.push({
        kind: "frequency_increase",
        merchant,
        delta,
        detail: `spend up ${delta.toFixed(2)} vs baseline`,
      });
    }
  }
  return drivers.sort((a, b) => b.delta - a.delta);
}
