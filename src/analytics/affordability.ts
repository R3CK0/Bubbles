/**
 * analytics/affordability.ts — THE solver. Allocates household free cash flow
 * across buffer, dated goals, debt paydown, contributions, and open goals.
 * Pure, deterministic, and fast (drag-to-replan re-runs it live).
 *
 * Free cash flow here = budgeted income − expense-kind budget. Minimum debt
 * payments are treated as bills already inside the expense budget; the solver
 * allocates the SURPLUS (extra paydown competes with goals/contributions).
 *
 * Allocation order each month — every line carries its reason:
 *   1. buffer         until bufferTarget is reached
 *   2. dated goals    priority asc, then earliest target date: requiredMonthly
 *   3. return race    extra debt paydown (APR) vs. contribution targets
 *                     (tax-adjusted return) — highest marginal return first
 *   4. open goals     (no date, e.g. emergency-fund top-up) priority asc
 *   5. unallocated    reported, not hidden
 */
import type { MonthISO } from "./types.js";
import { addMonths, monthOf, monthsBetween } from "./calendar.js";
import { roundCents } from "./money.js";
import { requiredMonthly, type GoalInput } from "./goals.js";

export interface SolverDebt {
  debtId: string;
  name: string;
  apr: number;
  balance: number;
}

export interface ContributionTarget {
  key: string; // e.g. 'nick:fhsa'
  personId: string | null;
  type: "fhsa" | "rrsp" | "tfsa";
  monthlyCap: number;
  /** Equivalent annual return %, incl. tax effect (optimizer supplies this). */
  equivalentReturn: number;
  reason: string;
}

export interface DiscretionaryCategory {
  categoryId: string;
  name: string;
  monthlyBudget: number;
}

export interface SolverInputs {
  startMonth: MonthISO;
  horizonMonths?: number;
  freeCashFlowMonthly: number;
  bufferTarget: number;
  bufferCurrent: number;
  goals: GoalInput[];
  debts: SolverDebt[];
  contributionTargets?: ContributionTarget[];
  discretionary?: DiscretionaryCategory[];
  /** Expected long-run investment return %, for ranking paydown. */
  expectedReturn?: number;
}

export interface PlanLineOut {
  month: MonthISO;
  targetType: "buffer" | "goal" | "debt" | "fhsa" | "rrsp" | "tfsa";
  targetId: string | null;
  personId: string | null;
  amount: number;
  reason: string;
}

export interface GoalVerdict {
  goalId: string;
  name: string;
  feasible: "yes" | "tight" | "no";
  fundedBy: MonthISO | null;
  gap: number;
  requiredMonthly: number | null;
}

export interface Suggestion {
  categoryId: string;
  name: string;
  cutMonthly: number;
  covers: string;
}

export interface SolveResult {
  schedule: PlanLineOut[];
  perGoal: GoalVerdict[];
  collisions: MonthISO[];
  unallocatedMonthly: { month: MonthISO; amount: number }[];
  suggestions: Suggestion[];
  horizonMonths: number;
}

export function solveAffordability(inputs: SolverInputs): SolveResult {
  const expectedReturn = inputs.expectedReturn ?? 5;
  const goals = inputs.goals
    .filter((g) => g.targetAmount > g.fundedAmount)
    .map((g) => ({ ...g, funded: g.fundedAmount }));

  const lastTarget = goals.reduce<string | null>(
    (max, g) => (g.targetDate && (!max || g.targetDate > max) ? g.targetDate : max),
    null,
  );
  const horizonMonths = Math.min(
    120,
    inputs.horizonMonths ??
      Math.max(24, lastTarget ? monthsBetween(inputs.startMonth, monthOf(lastTarget)).length + 3 : 24),
  );

  let bufferGap = Math.max(0, inputs.bufferTarget - inputs.bufferCurrent);
  const debts = inputs.debts.filter((d) => d.balance > 0.005).map((d) => ({ ...d, remaining: d.balance }));
  const contribs = (inputs.contributionTargets ?? []).map((c) => ({ ...c }));

  const schedule: PlanLineOut[] = [];
  const collisions: MonthISO[] = [];
  const unallocatedMonthly: { month: MonthISO; amount: number }[] = [];
  const fundedBy = new Map<string, MonthISO>();
  let shortfallTotal = 0;

  for (let i = 0; i < horizonMonths; i++) {
    const month = addMonths(inputs.startMonth, i);
    let cash = inputs.freeCashFlowMonthly;
    const push = (line: Omit<PlanLineOut, "month">) => {
      if (line.amount <= 0.005) return;
      schedule.push({ month, ...line, amount: roundCents(line.amount) });
    };

    // 1. buffer
    if (bufferGap > 0.005 && cash > 0) {
      const pay = Math.min(cash, bufferGap, Math.max(inputs.freeCashFlowMonthly * 0.5, 100));
      push({ targetType: "buffer", targetId: null, personId: null, amount: pay, reason: "rebuild cash buffer" });
      bufferGap = roundCents(bufferGap - pay);
      cash = roundCents(cash - pay);
    }

    // 2. dated goals by priority, then earliest date
    const dated = goals
      .filter((g) => g.targetDate && g.funded < g.targetAmount && monthOf(g.targetDate) >= month)
      .sort((a, b) => a.priority - b.priority || (a.targetDate! < b.targetDate! ? -1 : 1));
    let demanded = 0;
    for (const g of dated) {
      const need = requiredMonthly({ ...g, fundedAmount: g.funded }, month) ?? 0;
      demanded += need;
      if (need <= 0) continue;
      const pay = Math.min(cash, need, g.targetAmount - g.funded);
      if (pay > 0.005) {
        push({ targetType: "goal", targetId: g.goalId, personId: g.personId, amount: pay, reason: `fund '${g.name}' by ${g.targetDate}` });
        g.funded = roundCents(g.funded + pay);
        cash = roundCents(cash - pay);
        if (g.funded >= g.targetAmount - 0.005 && !fundedBy.has(g.goalId)) fundedBy.set(g.goalId, month);
      }
      if (pay < need - 0.005) shortfallTotal += need - pay;
    }
    if (demanded > inputs.freeCashFlowMonthly + 0.005) collisions.push(month);

    // 3. return race: extra paydown vs. contributions
    const race: { kind: "debt" | "contrib"; ret: number; idx: number }[] = [];
    debts.forEach((d, idx) => {
      if (d.remaining > 0.005) race.push({ kind: "debt", ret: d.apr, idx });
    });
    contribs.forEach((c, idx) => race.push({ kind: "contrib", ret: c.equivalentReturn, idx }));
    race.sort((a, b) => b.ret - a.ret);
    for (const r of race) {
      if (cash <= 0.005) break;
      if (r.kind === "debt") {
        const d = debts[r.idx]!;
        // Only prioritize paydown that beats investing; cheap debt waits.
        if (d.apr < expectedReturn - 1) continue;
        const pay = Math.min(cash, d.remaining);
        push({ targetType: "debt", targetId: d.debtId, personId: null, amount: pay, reason: `extra paydown '${d.name}' (${d.apr}% beats ~${expectedReturn}% investing)` });
        d.remaining = roundCents(d.remaining - pay);
        cash = roundCents(cash - pay);
      } else {
        const c = contribs[r.idx]!;
        const pay = Math.min(cash, c.monthlyCap);
        if (pay <= 0.005) continue;
        push({ targetType: c.type, targetId: null, personId: c.personId, amount: pay, reason: c.reason });
        cash = roundCents(cash - pay);
      }
    }

    // 4. open-ended goals absorb what's left, priority asc
    const open = goals
      .filter((g) => !g.targetDate && g.funded < g.targetAmount)
      .sort((a, b) => a.priority - b.priority);
    for (const g of open) {
      if (cash <= 0.005) break;
      const pay = Math.min(cash, g.targetAmount - g.funded);
      push({ targetType: "goal", targetId: g.goalId, personId: g.personId, amount: pay, reason: `top up '${g.name}'` });
      g.funded = roundCents(g.funded + pay);
      cash = roundCents(cash - pay);
      if (g.funded >= g.targetAmount - 0.005 && !fundedBy.has(g.goalId)) fundedBy.set(g.goalId, month);
    }

    if (cash > 0.005) unallocatedMonthly.push({ month, amount: roundCents(cash) });
  }

  const perGoal: GoalVerdict[] = inputs.goals.map((g) => {
    const sim = goals.find((s) => s.goalId === g.goalId);
    const funded = sim ? sim.funded : g.fundedAmount;
    const targetMonth = g.targetDate ? monthOf(g.targetDate) : null;
    const fundedMonth = fundedBy.get(g.goalId) ?? null;
    let feasible: GoalVerdict["feasible"];
    if (funded >= g.targetAmount - 0.005) {
      feasible = targetMonth && fundedMonth && fundedMonth >= targetMonth ? "tight" : "yes";
      if (targetMonth && fundedMonth && fundedMonth > targetMonth) feasible = "no";
    } else {
      feasible = "no";
    }
    return {
      goalId: g.goalId,
      name: g.name,
      feasible,
      fundedBy: fundedMonth,
      gap: roundCents(Math.max(0, g.targetAmount - funded)),
      requiredMonthly: requiredMonthly(g, inputs.startMonth),
    };
  });

  // Ranked cuts that close the average monthly shortfall.
  const suggestions: Suggestion[] = [];
  const failing = perGoal.filter((v) => v.feasible === "no");
  if (failing.length > 0 && (inputs.discretionary ?? []).length > 0) {
    const monthlyGap = roundCents(shortfallTotal / horizonMonths);
    let covered = 0;
    for (const d of [...inputs.discretionary!].sort((a, b) => b.monthlyBudget - a.monthlyBudget)) {
      if (covered >= monthlyGap) break;
      const cut = roundCents(Math.min(d.monthlyBudget * 0.5, monthlyGap - covered));
      if (cut < 5) continue;
      covered = roundCents(covered + cut);
      suggestions.push({
        categoryId: d.categoryId,
        name: d.name,
        cutMonthly: cut,
        covers: `${failing[0]!.name} shortfall (~$${monthlyGap.toFixed(0)}/mo)`,
      });
    }
  }

  return { schedule, perGoal, collisions, unallocatedMonthly, suggestions, horizonMonths };
}
