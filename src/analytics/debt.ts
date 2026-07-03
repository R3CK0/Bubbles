/**
 * analytics/debt.ts — amortization and payoff strategy. Pure.
 * Rates are annual percentages (20.99 = 20.99%); months are relative indexes
 * mapped to real MonthISO by the caller via startMonth.
 */
import type { MonthISO } from "./types.js";
import { addMonths } from "./calendar.js";
import { roundCents } from "./money.js";

export interface DebtInput {
  debtId: string;
  name: string;
  currentBalance: number;
  apr: number;
  minPayment: number | null;
}

export interface AmortizationRow {
  month: MonthISO;
  interest: number;
  principal: number;
  balance: number;
}

const MAX_MONTHS = 600;

/**
 * Fallback when a debt has no stated minimum: 2% of balance, floor $25 —
 * the common credit-card convention. Fixed at plan start.
 */
export function effectiveMinPayment(debt: DebtInput): number {
  if (debt.minPayment !== null && debt.minPayment > 0) return debt.minPayment;
  return roundCents(Math.max(debt.currentBalance * 0.02, 25));
}

/** Fixed-payment amortization until zero. Throws if payment can't cover interest. */
export function amortize(debt: DebtInput, payment: number, startMonth: MonthISO): AmortizationRow[] {
  const monthlyRate = debt.apr / 1200;
  let balance = debt.currentBalance;
  const rows: AmortizationRow[] = [];
  for (let i = 0; balance > 0.005 && i < MAX_MONTHS; i++) {
    const interest = roundCents(balance * monthlyRate);
    if (payment <= interest && balance > payment) {
      throw new Error(`payment ${payment} never retires '${debt.name}' (interest ${interest}/mo)`);
    }
    const principal = roundCents(Math.min(payment - interest, balance));
    balance = roundCents(balance - principal);
    rows.push({ month: addMonths(startMonth, i), interest, principal, balance });
  }
  return rows;
}

// ---- short-term (revolving) interest projection ----

export interface RevolvingMonthInput {
  /** Balance the statement asked to be paid (start-of-month carry). */
  statementBalance: number;
  /** Payments landed on the card so far this month (transfers in). */
  paidThisMonth: number;
  /** Live balance today — already net of this month's payments and purchases. */
  currentBalance: number;
  apr: number;
  /** Cards keep their grace period when the statement clears; LOCs never had one. */
  hasGracePeriod: boolean;
}

export interface RevolvingMonthProjection {
  /** What's still owed on the statement after this month's payments. */
  remainingStatement: number;
  /** True when the statement is fully paid — no interest next month even if new purchases exist. */
  statementCleared: boolean;
  /** Interest expected on next month's statement. */
  projectedInterest: number;
}

/**
 * Next month's interest for revolving debt. Grace-period rule: paying the full
 * statement balance means the card charges nothing next month — new purchases
 * ride the new grace window. Pay anything less and interest accrues on the
 * unpaid carry. Lines of credit accrue on the live balance regardless.
 */
export function projectRevolvingInterest(input: RevolvingMonthInput): RevolvingMonthProjection {
  const monthlyRate = input.apr / 1200;
  const remainingStatement = roundCents(Math.max(0, input.statementBalance - input.paidThisMonth));
  if (!input.hasGracePeriod) {
    // no grace period: interest accrues on whatever is drawn right now
    return {
      remainingStatement,
      statementCleared: remainingStatement <= 0.005,
      projectedInterest: roundCents(Math.max(0, input.currentBalance) * monthlyRate),
    };
  }
  const statementCleared = remainingStatement <= 0.005;
  return {
    remainingStatement,
    statementCleared,
    projectedInterest: statementCleared ? 0 : roundCents(remainingStatement * monthlyRate),
  };
}

// ---- long-term (installment) repayment ----

export interface RepaymentSchedule {
  monthlyPayment: number;
  monthsToFree: number;
  payoffMonth: MonthISO;
  /** Interest paid over the whole course of repayment. */
  totalInterest: number;
  rows: AmortizationRow[];
}

/**
 * Full-course repayment for one installment debt under a fixed budgeted
 * payment. Returns null when the payment can't even cover interest — the
 * caller flags it instead of looping forever.
 */
export function repaymentSchedule(
  debt: DebtInput,
  monthlyPayment: number,
  startMonth: MonthISO,
): RepaymentSchedule | null {
  if (debt.currentBalance <= 0.005) {
    return { monthlyPayment, monthsToFree: 0, payoffMonth: startMonth, totalInterest: 0, rows: [] };
  }
  if (monthlyPayment <= roundCents(debt.currentBalance * (debt.apr / 1200))) return null;
  const rows = amortize(debt, monthlyPayment, startMonth);
  const last = rows[rows.length - 1];
  if (!last || last.balance > 0.005) return null; // hit MAX_MONTHS without retiring
  return {
    monthlyPayment,
    monthsToFree: rows.length,
    payoffMonth: last.month,
    totalInterest: roundCents(rows.reduce((s, r) => s + r.interest, 0)),
    rows,
  };
}

export type PayoffStrategy = "avalanche" | "snowball";

export interface PayoffPlan {
  strategy: PayoffStrategy;
  months: MonthISO[];
  /** Balance at the END of each month, aligned with `months`. */
  perDebt: { debtId: string; name: string; balances: number[] }[];
  totalInterest: number;
  monthsToFree: number;
  debtFreeMonth: MonthISO | null;
}

/**
 * Roll-down payoff: every month pay minimums on all debts, direct the surplus
 * (monthlyBudget − Σ minimums) at the target debt — highest APR (avalanche)
 * or smallest balance (snowball). A retired debt's payment rolls to the next
 * target. Budget below Σ minimums throws.
 */
export function payoffPlan(
  debts: DebtInput[],
  monthlyBudget: number,
  strategy: PayoffStrategy,
  startMonth: MonthISO,
): PayoffPlan {
  const live = debts
    .filter((d) => d.currentBalance > 0.005)
    .map((d) => ({ ...d, balance: d.currentBalance, min: effectiveMinPayment(d) }));
  const minTotal = roundCents(live.reduce((s, d) => s + d.min, 0));
  if (live.length > 0 && monthlyBudget < minTotal) {
    throw new Error(`monthly budget ${monthlyBudget} is below the ${minTotal} of combined minimum payments`);
  }

  const months: MonthISO[] = [];
  const balancesByDebt = new Map<string, number[]>(live.map((d) => [d.debtId, []]));
  let totalInterest = 0;

  const pickTarget = () => {
    const open = live.filter((d) => d.balance > 0.005);
    if (open.length === 0) return null;
    return open.reduce((best, d) =>
      strategy === "avalanche"
        ? d.apr > best.apr || (d.apr === best.apr && d.balance < best.balance)
          ? d
          : best
        : d.balance < best.balance
          ? d
          : best,
    );
  };

  for (let i = 0; i < MAX_MONTHS; i++) {
    const open = live.filter((d) => d.balance > 0.005);
    if (open.length === 0) break;
    const month = addMonths(startMonth, i);
    months.push(month);

    // Interest accrues first.
    for (const d of open) {
      const interest = roundCents(d.balance * (d.apr / 1200));
      d.balance = roundCents(d.balance + interest);
      totalInterest = roundCents(totalInterest + interest);
    }
    // Minimums (capped at balance) …
    let available = monthlyBudget;
    for (const d of open) {
      const pay = Math.min(d.min, d.balance);
      d.balance = roundCents(d.balance - pay);
      available = roundCents(available - pay);
    }
    // … then surplus rolls at the strategy target, cascading on payoff.
    let target = pickTarget();
    while (target && available > 0.005) {
      const pay = Math.min(available, target.balance);
      target.balance = roundCents(target.balance - pay);
      available = roundCents(available - pay);
      target = pickTarget();
    }
    for (const d of live) balancesByDebt.get(d.debtId)!.push(d.balance);
  }

  return {
    strategy,
    months,
    perDebt: live.map((d) => ({ debtId: d.debtId, name: d.name, balances: balancesByDebt.get(d.debtId)! })),
    totalInterest,
    monthsToFree: months.length,
    debtFreeMonth: months.length > 0 ? months[months.length - 1]! : null,
  };
}

export interface StrategyComparison {
  avalanche: PayoffPlan;
  snowball: PayoffPlan;
  monthsSaved: number;
  interestSaved: number;
}

/** Avalanche vs. snowball under the same budget (avalanche never loses). */
export function compareStrategies(
  debts: DebtInput[],
  monthlyBudget: number,
  startMonth: MonthISO,
): StrategyComparison {
  const avalanche = payoffPlan(debts, monthlyBudget, "avalanche", startMonth);
  const snowball = payoffPlan(debts, monthlyBudget, "snowball", startMonth);
  return {
    avalanche,
    snowball,
    monthsSaved: snowball.monthsToFree - avalanche.monthsToFree,
    interestSaved: roundCents(snowball.totalInterest - avalanche.totalInterest),
  };
}

/**
 * Paying down APR r% is a guaranteed after-tax return of r% — the number the
 * affordability solver ranks against expected investment returns (step 3).
 */
export function marginalReturnOfPaydown(debt: Pick<DebtInput, "apr">): number {
  return debt.apr;
}
