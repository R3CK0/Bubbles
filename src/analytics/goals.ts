/**
 * analytics/goals.ts — per-type goal math. Pure.
 */
import type { MonthISO } from "./types.js";
import { monthOf, monthsBetween } from "./calendar.js";
import { roundCents } from "./money.js";

/**
 * How a goal measures progress:
 *  - saving:   a linked account balance climbs toward the target amount
 *  - spending: transactions tagged to the goal spend down its own budget
 *  - loan:     a linked debt/account balance falls toward the target amount
 */
export type GoalCategory = "saving" | "spending" | "loan";

export interface GoalInput {
  goalId: string;
  goalType: string;
  /** Defaults to "saving" when absent (extra/what-if goals). */
  category?: GoalCategory;
  name: string;
  personId: string | null;
  priority: number;
  targetAmount: number;
  fundedAmount: number;
  targetDate: string | null;
}

/**
 * Express a loan-payoff goal ("reduce the balance to X by date D") in the
 * sinking-fund terms the solver and progress math already speak:
 * targetAmount = total to pay down, fundedAmount = paid down so far.
 */
export function loanGoalAsFunding(state: { startBalance: number; currentBalance: number; targetBalance: number }): {
  targetAmount: number;
  fundedAmount: number;
} {
  const targetAmount = Math.max(0, state.startBalance - state.targetBalance);
  const fundedAmount = Math.min(targetAmount, Math.max(0, state.startBalance - state.currentBalance));
  return { targetAmount: roundCents(targetAmount), fundedAmount: roundCents(fundedAmount) };
}

/**
 * Flat sinking-fund requirement to hit the target by its date; null for
 * open-ended goals (emergency fund) — those absorb surplus instead.
 */
export function requiredMonthly(goal: GoalInput, asOfMonth: MonthISO): number | null {
  if (!goal.targetDate) return null;
  const remaining = Math.max(0, goal.targetAmount - goal.fundedAmount);
  if (remaining === 0) return 0;
  const targetMonth = monthOf(goal.targetDate);
  const monthsLeft = targetMonth <= asOfMonth ? 1 : monthsBetween(asOfMonth, targetMonth).length;
  return roundCents(remaining / monthsLeft);
}

export function goalProgress(goal: Pick<GoalInput, "targetAmount" | "fundedAmount">): number {
  if (goal.targetAmount <= 0) return 1;
  return Math.min(1, Math.round((goal.fundedAmount / goal.targetAmount) * 1000) / 1000);
}

// ---- house ----

export interface HouseParams {
  /** Contract rate offered (annual %); qualification uses the stress test. */
  rate: number;
  amortYears?: number;
  downPaymentPct?: number;
  grossAnnualIncome: number;
  /** Non-housing monthly debt obligations (TDS side). */
  monthlyDebtPayments: number;
  heatMonthly?: number;
  /** Annual property tax as a fraction of price. */
  propertyTaxRate?: number;
}

export interface HouseAffordability {
  qualifyingRate: number;
  maxMonthlyPayment: number;
  maxMortgage: number;
  maxPrice: number;
  downPaymentNeeded: number;
  bindingConstraint: "GDS" | "TDS";
}

/** Monthly payment for principal P at annual rate r% over n years. */
export function mortgagePayment(principal: number, annualRate: number, years: number): number {
  const r = annualRate / 1200;
  const n = years * 12;
  if (r === 0) return roundCents(principal / n);
  return roundCents((principal * r) / (1 - Math.pow(1 + r, -n)));
}

/**
 * Canadian qualification math: stress-test rate max(contract + 2, 5.25),
 * GDS ≤ 39% (housing costs / gross income), TDS ≤ 44% (housing + debts).
 * Solves the max price where payment + tax + heat fits the binding ratio.
 */
export function houseAffordability(params: HouseParams): HouseAffordability {
  const amortYears = params.amortYears ?? 25;
  const downPct = params.downPaymentPct ?? 0.2;
  const heat = params.heatMonthly ?? 150;
  const taxRate = params.propertyTaxRate ?? 0.01;
  const qualifyingRate = Math.max(params.rate + 2, 5.25);
  const monthlyIncome = params.grossAnnualIncome / 12;

  const gdsRoom = monthlyIncome * 0.39 - heat;
  const tdsRoom = monthlyIncome * 0.44 - heat - params.monthlyDebtPayments;
  const bindingConstraint: "GDS" | "TDS" = tdsRoom < gdsRoom ? "TDS" : "GDS";
  const housingRoom = Math.max(0, Math.min(gdsRoom, tdsRoom));

  // payment(price) + tax(price) ≤ housingRoom, payment on (1−down)·price:
  // price · [payFactor·(1−down) + taxRate/12] = housingRoom
  const payFactorPerDollar = mortgagePaymentFactor(qualifyingRate, amortYears);
  const perDollar = payFactorPerDollar * (1 - downPct) + taxRate / 12;
  const maxPrice = perDollar > 0 ? housingRoom / perDollar : 0;
  const maxMortgage = maxPrice * (1 - downPct);

  return {
    qualifyingRate,
    maxMonthlyPayment: roundCents(housingRoom),
    maxMortgage: roundCents(maxMortgage),
    maxPrice: roundCents(maxPrice),
    downPaymentNeeded: roundCents(maxPrice * downPct),
    bindingConstraint,
  };
}

function mortgagePaymentFactor(annualRate: number, years: number): number {
  const r = annualRate / 1200;
  const n = years * 12;
  if (r === 0) return 1 / n;
  return r / (1 - Math.pow(1 + r, -n));
}

// ---- kids ----

export interface KidParams {
  /** Months of parental leave and the monthly net income dip during them (QPIP gap). */
  leaveMonths: number;
  incomeDipMonthly: number;
  /** Recurring childcare cost after leave ends, and how long to model it. */
  childcareMonthly: number;
  childcareMonths?: number;
  oneTimeCosts?: number;
}

export interface KidCostPoint {
  monthIndex: number;
  extraCost: number;
}

/** Monthly extra-cost curve from birth: leave dip first, childcare after. */
export function kidCostCurve(params: KidParams): { curve: KidCostPoint[]; oneTime: number; totalFirstFiveYears: number } {
  const childcareMonths = params.childcareMonths ?? 48;
  const curve: KidCostPoint[] = [];
  const horizon = params.leaveMonths + childcareMonths;
  for (let m = 0; m < horizon; m++) {
    const extraCost = m < params.leaveMonths ? params.incomeDipMonthly : params.childcareMonthly;
    curve.push({ monthIndex: m, extraCost: roundCents(extraCost) });
  }
  const oneTime = params.oneTimeCosts ?? 0;
  const first60 = curve.slice(0, 60).reduce((s, p) => s + p.extraCost, 0) + oneTime;
  return { curve, oneTime, totalFirstFiveYears: roundCents(first60) };
}

// ---- events ----

export interface EventLineItem {
  amount: number;
  status: "planned" | "deposit_paid" | "paid" | "cancelled";
}

export interface EventBudget {
  committed: number;
  paid: number;
  remaining: number;
}

/** Wedding-style envelope: committed vs. paid vs. still to fund. */
export function eventBudget(lineItems: EventLineItem[]): EventBudget {
  const live = lineItems.filter((i) => i.status !== "cancelled");
  const committed = roundCents(live.reduce((s, i) => s + i.amount, 0));
  const paid = roundCents(live.filter((i) => i.status === "paid").reduce((s, i) => s + i.amount, 0));
  return { committed, paid, remaining: roundCents(committed - paid) };
}
