/**
 * engine/budgetService.ts — Budget page: targets, actuals, variances.
 * Budgets are versioned: every edit creates a new budget_versions row
 * effective from a given month, so past months keep the budget they had.
 */
import {
  budgetVsActual,
  computeCashflow,
  daysInMonth,
  estimateTax,
  monthOf,
  relevantFlows,
  roundCents,
  signedFlow,
  type BudgetLineInput,
  type BudgetVsActualRow,
  type CategoryNode,
  type TaxTables,
  type VarianceDriver,
} from "../analytics/index.js";
import type { EngineContext } from "./context.js";
import {
  activeBudgetForMonth,
  createBudgetVersion,
  flowsForRange,
  listBudgetVersions,
  listCategories,
  toCategoryNode,
  type BudgetVersionRow,
} from "../db/repositories/budgeting.js";
import { latestTaxProfiles, latestTaxTables, type TaxProfileRow } from "../db/repositories/tax.js";
import { getCategoryDrilldown } from "./cashflowService.js";

export interface BudgetView {
  version: BudgetVersionRow | null;
  month: string;
  dayFraction: number;
  rows: BudgetVsActualRow[];
}

function dayFractionFor(ctx: EngineContext): number {
  if (ctx.month < monthOf(ctx.today)) return 1;
  if (ctx.month > monthOf(ctx.today)) return 0;
  return Number(ctx.today.slice(8, 10)) / daysInMonth(ctx.month);
}

interface ExtraIncomeJson {
  rentalNet?: number;
  interest?: number;
  eligibleDividends?: number;
  capitalGains?: number;
  donations?: number;
  medicalExpenses?: number;
}

function parseExtra(json: string | null): ExtraIncomeJson {
  if (!json) return {};
  try {
    return JSON.parse(json) as ExtraIncomeJson;
  } catch {
    return {};
  }
}

/**
 * One person's after-tax monthly income — the wizard's "Total monthly, after
 * tax": weekly take-home ×52÷12 (else the bracket estimate's job-only net),
 * plus extra income (rental/interest/dividends/gains) net at the marginal
 * rate, gains at the 50% inclusion rate. Mirrors web/src/lib/tax.ts.
 */
function derivedMonthlyIncome(profile: TaxProfileRow, year: number, tables: TaxTables | null): number {
  const extra = parseExtra(profile.other_income_json);
  const ordinary = (extra.rentalNet ?? 0) + (extra.interest ?? 0) + (extra.eligibleDividends ?? 0);
  const gains = extra.capitalGains ?? 0;
  const weekly = profile.weekly_take_home ?? 0;

  if (!tables) {
    // no bracket tables for the year — degrade to gross figures
    return (weekly > 0 ? (weekly * 52) / 12 : (profile.employment_income ?? 0) / 12) + (ordinary + gains) / 12;
  }

  const est = estimateTax(
    {
      personId: profile.person_id,
      taxYear: year,
      employmentIncome: profile.employment_income ?? 0,
      rentalNet: extra.rentalNet ?? 0,
      interestIncome: extra.interest ?? 0,
      eligibleDividends: extra.eligibleDividends ?? 0,
      capitalGains: gains,
      rrspDeduction: 0,
      fhsaDeduction: 0,
      donations: extra.donations ?? 0,
      medicalExpenses: extra.medicalExpenses ?? 0,
      withholdingPaid: 0,
    },
    tables,
  );
  const extraNetAnnual = ordinary * (1 - est.marginalRate) + gains * (1 - est.marginalRate * 0.5);
  const jobNetAnnual = est.totalIncome - est.totalIncomeTax - est.payroll.total - extraNetAnnual;
  const baseMonthly = weekly > 0 ? (weekly * 52) / 12 : jobNetAnnual / 12;
  return baseMonthly + extraNetAnnual / 12;
}

/**
 * Income budget lines are derived live from the household income settings
 * (tax profiles) — editing a salary, take-home, or extra income in Settings
 * reflects in the budget immediately instead of leaving a stale snapshot line
 * behind. Stored income lines remain the fallback for households that never
 * saved incomes.
 */
function withDerivedIncomeLines(
  lines: BudgetLineInput[],
  categories: CategoryNode[],
  month: string,
): BudgetLineInput[] {
  const year = Number(month.slice(0, 4));
  // bracket tables for the viewed year, else the newest seeded year
  const tables = latestTaxTables(year) ?? latestTaxTables(new Date().getFullYear());
  const derived = latestTaxProfiles(year)
    .map((p) => ({ personId: p.person_id, monthly: derivedMonthlyIncome(p, year, tables) }))
    .filter((d) => d.monthly > 0);
  if (derived.length === 0) return lines;

  const income = categories.filter((c) => c.kind === "income");
  const target = income.find((c) => c.categoryId === "income") ?? income.find((c) => c.parentId === null) ?? income[0];
  if (!target) return lines;

  const incomeIds = new Set(income.map((c) => c.categoryId));
  return [
    ...lines.filter((l) => !incomeIds.has(l.categoryId)),
    ...derived.map((d) => ({
      categoryId: target.categoryId,
      personId: d.personId,
      monthlyAmount: roundCents(d.monthly),
    })),
  ];
}

export function getBudgetView(ctx: EngineContext): BudgetView {
  const categories = listCategories().map(toCategoryNode);
  const active = activeBudgetForMonth(ctx.month);
  const stored: BudgetLineInput[] = (active?.lines ?? []).map((l) => ({
    categoryId: l.category_id,
    personId: l.person_id,
    monthlyAmount: l.monthly_amount,
  }));
  const lines = withDerivedIncomeLines(stored, categories, ctx.month);

  const flows = flowsForRange(ctx.range);
  const summary = computeCashflow(flows, categories, ctx.lens, ctx.range);
  const actuals = new Map<string, number>();
  for (const row of summary.byCategory) {
    if (row.categoryId !== null) actuals.set(row.categoryId, row.amount);
  }
  // byCategory covers spending only — fold categorized income in as well so
  // the budget's income rows show actuals, not a permanent zero
  const catIndex = new Map(categories.map((c) => [c.categoryId, c]));
  for (const t of relevantFlows(flows, ctx.lens, ctx.range)) {
    const cat = t.categoryId ? catIndex.get(t.categoryId) : undefined;
    if (cat?.kind === "income") {
      actuals.set(cat.categoryId, roundCents((actuals.get(cat.categoryId) ?? 0) + signedFlow(t)));
    }
  }

  const dayFraction = dayFractionFor(ctx);
  return {
    version: active?.version ?? null,
    month: ctx.month,
    dayFraction,
    rows: budgetVsActual(lines, actuals, categories, ctx.lens, dayFraction),
  };
}

export interface BudgetLinePatch {
  categoryId: string;
  personId: string | null;
  monthlyAmount: number;
}

/**
 * Replace the budget from `effectiveFrom` (YYYY-MM) onward: clones the
 * currently-active lines, applies the patches, writes a new version.
 */
export function updateBudgetLines(
  effectiveFrom: string,
  patches: BudgetLinePatch[],
  name?: string,
): BudgetVersionRow {
  const current = activeBudgetForMonth(effectiveFrom);
  const merged = new Map<string, BudgetLinePatch>();
  for (const l of current?.lines ?? []) {
    merged.set(`${l.category_id}|${l.person_id ?? ""}`, {
      categoryId: l.category_id,
      personId: l.person_id,
      monthlyAmount: l.monthly_amount,
    });
  }
  for (const p of patches) {
    const key = `${p.categoryId}|${p.personId ?? ""}`;
    if (p.monthlyAmount === 0) merged.delete(key);
    else merged.set(key, p);
  }
  return createBudgetVersion(
    name ?? `Budget from ${effectiveFrom}`,
    `${effectiveFrom}-01`,
    null,
    [...merged.values()].map((p) => ({
      category_id: p.categoryId,
      person_id: p.personId,
      monthly_amount: p.monthlyAmount,
    })),
    new Date().toISOString(),
  );
}

export function getBudgetVersions(): BudgetVersionRow[] {
  return listBudgetVersions();
}

/**
 * Clear the budget from `effectiveFrom` onward: writes a new version with no
 * lines at all, so every category starts back at zero and the user can build
 * a fresh budget. Past months keep the versions that governed them; income
 * lines keep deriving live from the household income settings.
 */
export function resetBudget(effectiveFrom: string, name?: string): BudgetVersionRow {
  return createBudgetVersion(
    name ?? `Fresh budget from ${effectiveFrom}`,
    `${effectiveFrom}-01`,
    "cleared",
    [],
    new Date().toISOString(),
  );
}

export interface CategoryVarianceNarrative {
  categoryId: string;
  name: string;
  variance: number;
  drivers: VarianceDriver[];
}

/** Top overspent categories with their decomposed drivers. */
export function getVarianceNarratives(ctx: EngineContext, top = 5): CategoryVarianceNarrative[] {
  const view = getBudgetView(ctx);
  return view.rows
    .filter((r) => r.kind === "expense" && r.budget > 0 && r.variance > 0)
    .slice(0, top)
    .map((r) => ({
      categoryId: r.categoryId,
      name: r.name,
      variance: r.variance,
      drivers: getCategoryDrilldown(ctx, r.categoryId).drivers.slice(0, 3),
    }));
}
