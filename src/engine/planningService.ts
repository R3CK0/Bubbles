/**
 * engine/planningService.ts — Goals page, the solver runs, plan lifecycle.
 *
 * Free cash flow = budgeted income − expense-kind budget (savings-kind lines
 * are themselves solver-allocatable, so they're excluded from "spend").
 */
import {
  eventBudget,
  goalProgress,
  requiredMonthly,
  roundCents,
  solveAffordability,
  inLens,
  type ContributionTarget,
  type DiscretionaryCategory,
  type GoalInput,
  type SolveResult,
  type SolverInputs,
} from "../analytics/index.js";
import type { EngineContext } from "./context.js";
import { getDb } from "../db/db.js";
import {
  activePlan,
  approvePlan as repoApprovePlan,
  createDraftPlan,
  createGoal as repoCreateGoal,
  createScenario,
  deleteLineItem,
  deleteScenario,
  getGoal,
  getScenario,
  listGoals,
  listLineItems,
  listScenarios,
  refreshFundedFromLinkedAccounts,
  toGoalInput,
  updateGoal as repoUpdateGoal,
  upsertLineItem,
  type GoalCreate,
  type GoalLineItemRow,
  type GoalRow,
  type PlanLineRow,
  type PlanRow,
  type ScenarioRow,
} from "../db/repositories/planning.js";
import { activeBudgetForMonth, goalLineTaggedSpend, goalTaggedSpend, listCategories } from "../db/repositories/budgeting.js";
import { listDebts, toDebtInput } from "../db/repositories/debts.js";
import { effectiveMinPayment } from "../analytics/debt.js";
import { getNumberSetting } from "../db/repositories/ops.js";

export interface GoalCardOut extends GoalRow {
  progress: number;
  requiredMonthly: number | null;
  /** Line items double as the goal's subcategories; `spent` sums the transactions tagged to each. */
  lineItems: (GoalLineItemRow & { spent: number })[];
  eventBudget: { committed: number; paid: number; remaining: number } | null;
  /** Net spend of transactions tagged to this goal (excluded from the budget). */
  taggedSpend: { total: number; month: number };
}

export function getGoalsView(ctx: EngineContext): { goals: GoalCardOut[]; solve: SolveResult } {
  const goals = listGoals("active").filter((g) => inLens(g.person_id, ctx.lens));
  const taggedTotal = goalTaggedSpend();
  const taggedMonth = goalTaggedSpend(ctx.range);
  const cards = goals.map((g) => {
    const input = toGoalInput(g);
    const lineSpend = goalLineTaggedSpend(g.goal_id);
    const lineItems = listLineItems(g.goal_id).map((li) => ({
      ...li,
      spent: lineSpend.get(li.line_id) ?? 0,
    }));
    return {
      ...g,
      progress: goalProgress(input),
      requiredMonthly: requiredMonthly(input, ctx.month),
      lineItems,
      eventBudget: g.goal_type === "event" && lineItems.length > 0 ? eventBudget(lineItems) : null,
      taggedSpend: { total: taggedTotal.get(g.goal_id) ?? 0, month: taggedMonth.get(g.goal_id) ?? 0 },
    };
  });
  return { goals: cards, solve: solve(ctx) };
}

export interface SolveOverrides {
  freeCashFlowMonthly?: number;
  bufferTarget?: number;
  goalShifts?: { goalId: string; targetDate: string | null }[];
  contributionTargets?: ContributionTarget[];
  extraGoals?: GoalInput[];
}

function budgetedFreeCashFlow(month: string): number {
  const budget = activeBudgetForMonth(month);
  if (!budget) return 0;
  const kinds = new Map(listCategories(true).map((c) => [c.category_id, c.kind]));
  let income = 0;
  let expense = 0;
  for (const line of budget.lines) {
    const kind = kinds.get(line.category_id);
    if (kind === "income") income += line.monthly_amount;
    else if (kind === "expense") expense += line.monthly_amount;
  }
  return roundCents(income - expense);
}

function discretionaryCategories(month: string): DiscretionaryCategory[] {
  const budget = activeBudgetForMonth(month);
  if (!budget) return [];
  const categories = listCategories();
  const byId = new Map(categories.map((c) => [c.category_id, c]));
  const CUTTABLE_PARENTS = new Set(["subs-entertainment", "subs-lifestyle"]);
  const CUTTABLE_IDS = new Set(["essentials-restaurants", "essentials-clothing"]);
  const totals = new Map<string, number>();
  for (const line of budget.lines) {
    const cat = byId.get(line.category_id);
    if (!cat) continue;
    if ((cat.parent_id && CUTTABLE_PARENTS.has(cat.parent_id)) || CUTTABLE_IDS.has(cat.category_id)) {
      totals.set(cat.category_id, (totals.get(cat.category_id) ?? 0) + line.monthly_amount);
    }
  }
  return [...totals.entries()].map(([categoryId, monthlyBudget]) => ({
    categoryId,
    name: byId.get(categoryId)?.name ?? categoryId,
    monthlyBudget: roundCents(monthlyBudget),
  }));
}

export { budgetedFreeCashFlow };

export function buildSolverInputs(ctx: EngineContext, overrides: SolveOverrides = {}): SolverInputs {
  let goals = listGoals("active")
    .filter((g) => inLens(g.person_id, ctx.lens))
    .map(toGoalInput);
  for (const shift of overrides.goalShifts ?? []) {
    goals = goals.map((g) => (g.goalId === shift.goalId ? { ...g, targetDate: shift.targetDate } : g));
  }
  if (overrides.extraGoals) goals = [...goals, ...overrides.extraGoals];

  const bufferCurrent = (
    getDb()
      .prepare(
        `SELECT COALESCE(SUM(current_balance), 0) AS s FROM accounts WHERE tracked = 1 AND is_closed = 0 AND type = 'depository'`,
      )
      .get() as { s: number }
  ).s;

  return {
    startMonth: ctx.month,
    freeCashFlowMonthly: overrides.freeCashFlowMonthly ?? budgetedFreeCashFlow(ctx.month),
    bufferTarget: overrides.bufferTarget ?? getNumberSetting("buffer_target", getNumberSetting("buffer_floor", 500)),
    bufferCurrent: roundCents(bufferCurrent),
    goals,
    debts: listDebts("active").map((d) => {
      const input = toDebtInput(d);
      return { debtId: d.debt_id, name: d.name, apr: d.apr, balance: Math.max(0, d.current_balance - 0) };
    }),
    contributionTargets: overrides.contributionTargets ?? [],
    discretionary: discretionaryCategories(ctx.month),
  };
}

export function solve(ctx: EngineContext, overrides: SolveOverrides = {}): SolveResult {
  return solveAffordability(buildSolverInputs(ctx, overrides));
}

// ---- goal CRUD passthroughs ----

export function createGoal(input: GoalCreate): GoalRow {
  return repoCreateGoal(input, new Date().toISOString());
}

export interface GoalPatch {
  name?: string;
  targetAmount?: number;
  targetDate?: string | null;
  priority?: number;
  personId?: string | null;
  linkedAccountId?: string | null;
  fundedAmount?: number;
  status?: GoalRow["status"];
  notes?: string | null;
  params?: unknown;
}

export function updateGoal(goalId: string, patch: GoalPatch): GoalRow | undefined {
  if (!getGoal(goalId)) return undefined;
  return repoUpdateGoal(goalId, {
    name: patch.name,
    target_amount: patch.targetAmount,
    target_date: patch.targetDate,
    priority: patch.priority,
    person_id: patch.personId,
    linked_account_id: patch.linkedAccountId,
    funded_amount: patch.fundedAmount,
    status: patch.status,
    notes: patch.notes,
    params_json: patch.params === undefined ? undefined : JSON.stringify(patch.params),
  });
}

export function saveLineItem(goalId: string, input: { lineId?: string; name: string; amount: number; dueDate?: string | null; status?: GoalLineItemRow["status"]; transactionId?: string | null }): GoalLineItemRow {
  const row: GoalLineItemRow = {
    line_id: input.lineId ?? crypto.randomUUID(),
    goal_id: goalId,
    name: input.name,
    amount: input.amount,
    due_date: input.dueDate ?? null,
    status: input.status ?? "planned",
    transaction_id: input.transactionId ?? null,
  };
  upsertLineItem(row);
  return row;
}

export function removeLineItem(lineId: string): void {
  deleteLineItem(lineId);
}

// ---- plans ----

export function approveSolveAsPlan(ctx: EngineContext, name: string, overrides: SolveOverrides = {}): { plan: PlanRow; lines: number } {
  const inputs = buildSolverInputs(ctx, overrides);
  const result = solveAffordability(inputs);
  const lines: Omit<PlanLineRow, "plan_id">[] = result.schedule.map((l) => ({
    month: l.month,
    person_id: l.personId,
    target_type: l.targetType,
    target_id: l.targetId,
    amount: l.amount,
  }));
  const now = new Date().toISOString();
  const draft = createDraftPlan(name, inputs, lines, now);
  const plan = repoApprovePlan(draft.plan_id, now)!;
  return { plan, lines: lines.length };
}

export function getActivePlan(): { plan: PlanRow; lines: PlanLineRow[] } | null {
  return activePlan();
}

/** Nightly: refresh funded amounts from linked account balances. */
export function refreshGoalFunding(): number {
  return refreshFundedFromLinkedAccounts();
}

// ---- scenarios ----

export interface ScenarioParams {
  freeCashFlowDelta?: number;
  bufferTarget?: number;
  goalShifts?: { goalId: string; targetDate: string | null }[];
}

export function addScenario(name: string, params: ScenarioParams, notes: string | null): ScenarioRow {
  return createScenario(name, params, notes, new Date().toISOString());
}

export function getScenarios(): ScenarioRow[] {
  return listScenarios();
}

export function removeScenario(scenarioId: string): void {
  deleteScenario(scenarioId);
}

export function solveScenario(ctx: EngineContext, scenarioId: string): SolveResult | null {
  const scenario = getScenario(scenarioId);
  if (!scenario) return null;
  const params = JSON.parse(scenario.params_json) as ScenarioParams;
  const base = buildSolverInputs(ctx, { goalShifts: params.goalShifts, bufferTarget: params.bufferTarget });
  return solveAffordability({
    ...base,
    freeCashFlowMonthly: roundCents(base.freeCashFlowMonthly + (params.freeCashFlowDelta ?? 0)),
  });
}
