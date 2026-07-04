/**
 * engine/debtService.ts — Debt page payloads and debt lifecycle.
 */
import {
  addMonths,
  compareStrategies,
  effectiveMinPayment,
  monthOf,
  monthsBetween,
  payoffPlan,
  projectRevolvingInterest,
  repaymentSchedule,
  roundCents,
  type PayoffPlan,
  type PayoffStrategy,
  type StrategyComparison,
} from "../analytics/index.js";
import type { EngineContext } from "./context.js";
import {
  accountNetChange,
  createDebt as repoCreateDebt,
  getDebt,
  listDebts,
  rateHistory,
  statementsForMonth,
  toDebtInput,
  updateDebt as repoUpdateDebt,
  upsertDebtStatement,
  type DebtCreate,
  type DebtRow,
  type DebtStatementRow,
} from "../db/repositories/debts.js";
import { flowsForRange, transferLegsForRange } from "../db/repositories/budgeting.js";
import { listRecurring } from "../db/repositories/recurring.js";
import { inLens } from "../analytics/cashflow.js";

/** Revolving credit lives on the short-term screen; installment loans on the long-term one. */
export const SHORT_TERM_KINDS: ReadonlySet<DebtRow["kind"]> = new Set(["credit_card", "line_of_credit", "other"]);

export interface DebtOverviewItem extends DebtRow {
  effectiveMinPayment: number;
  rateHistory: { effective_date: string; apr: number }[];
}

export interface DebtOverview {
  debts: DebtOverviewItem[];
  totalBalance: number;
  totalMinPayments: number;
}

export function getDebtOverview(ctx: EngineContext): DebtOverview {
  const debts = listDebts("active").filter((d) => inLens(d.person_id, ctx.lens));
  const items = debts.map((d) => ({
    ...d,
    effectiveMinPayment: effectiveMinPayment(toDebtInput(d)),
    rateHistory: rateHistory(d.debt_id),
  }));
  return {
    debts: items,
    totalBalance: roundCents(items.reduce((s, d) => s + d.current_balance, 0)),
    totalMinPayments: roundCents(items.reduce((s, d) => s + d.effectiveMinPayment, 0)),
  };
}

/**
 * Budget defaults to Σ minimums + extra; the plan starts at the viewed month.
 * Long-term (installment) debts only — revolving credit turns over monthly
 * and lives on the short-term screen, so it would only distort the mountain.
 */
export function getPayoffPlan(ctx: EngineContext, strategy: PayoffStrategy, extraMonthly: number): PayoffPlan {
  const inputs = listDebts("active")
    .filter((d) => !SHORT_TERM_KINDS.has(d.kind) && inLens(d.person_id, ctx.lens))
    .map(toDebtInput);
  const budget = roundCents(inputs.reduce((s, d) => s + effectiveMinPayment({ ...d, minPayment: d.minPayment }), 0) + extraMonthly);
  return payoffPlan(inputs, budget, strategy, ctx.month);
}

export function getStrategyComparison(ctx: EngineContext, extraMonthly: number): StrategyComparison {
  const inputs = listDebts("active")
    .filter((d) => !SHORT_TERM_KINDS.has(d.kind) && inLens(d.person_id, ctx.lens))
    .map(toDebtInput);
  const budget = roundCents(inputs.reduce((s, d) => s + effectiveMinPayment(d), 0) + extraMonthly);
  return compareStrategies(inputs, budget, ctx.month);
}

export function createDebt(input: DebtCreate): DebtRow {
  return repoCreateDebt(input, new Date().toISOString());
}

export interface DebtPatch {
  name?: string;
  kind?: DebtRow["kind"];
  currentBalance?: number;
  apr?: number;
  minPayment?: number | null;
  paymentDay?: number | null;
  maturityDate?: string | null;
  status?: DebtRow["status"];
  personId?: string | null;
  accountId?: string | null;
}

export function updateDebt(debtId: string, patch: DebtPatch): DebtRow | undefined {
  if (!getDebt(debtId)) return undefined;
  return repoUpdateDebt(debtId, {
    name: patch.name,
    kind: patch.kind,
    current_balance: patch.currentBalance,
    apr: patch.apr,
    min_payment: patch.minPayment,
    payment_day: patch.paymentDay,
    maturity_date: patch.maturityDate,
    status: patch.status,
    person_id: patch.personId,
    account_id: patch.accountId,
  });
}

// ---- short-term screen: revolving credit, next month's interest ----

export interface ShortTermDebtItem extends DebtRow {
  effectiveMinPayment: number;
  /** This month's statement entry, if the user recorded one. */
  dueDate: string | null;
  minimumDue: number | null;
  /** Credit cards must carry a pay-by date every month. */
  needsDueDate: boolean;
  /** Statement balance: user-entered, else the computed start-of-month carry. */
  statementBalance: number;
  statementSource: "statement" | "computed";
  /** Transfers that landed on the card this month. */
  paidThisMonth: number;
  remainingStatement: number;
  statementCleared: boolean;
  /** Interest expected on next month's statement (0 when cleared — grace period). */
  projectedInterest: number;
}

export interface ShortTermDebtView {
  month: string;
  debts: ShortTermDebtItem[];
  totalBalance: number;
  totalPaidThisMonth: number;
  totalProjectedInterest: number;
  missingDueDates: number;
}

export function getShortTermDebtView(ctx: EngineContext): ShortTermDebtView {
  const debts = listDebts("active").filter(
    (d) => SHORT_TERM_KINDS.has(d.kind) && inLens(d.person_id, ctx.lens),
  );
  const statements = statementsForMonth(ctx.month);

  // payments = inflow legs of marked transfers landing on each debt's account
  const paidByAccount = new Map<string, number>();
  for (const leg of transferLegsForRange(ctx.range)) {
    if (leg.amount >= 0) continue;
    paidByAccount.set(
      leg.account_id,
      roundCents((paidByAccount.get(leg.account_id) ?? 0) - leg.amount),
    );
  }

  const items = debts.map((d): ShortTermDebtItem => {
    const stmt = statements.get(d.debt_id);
    const paidThisMonth = d.account_id ? (paidByAccount.get(d.account_id) ?? 0) : 0;
    // start-of-month carry: today's balance minus everything that happened since the 1st
    const computedCarry = d.account_id
      ? Math.max(0, roundCents(d.current_balance - accountNetChange(d.account_id, ctx.range)))
      : d.current_balance;
    const statementBalance = stmt?.statement_balance ?? computedCarry;
    const projection = projectRevolvingInterest({
      statementBalance,
      paidThisMonth,
      currentBalance: d.current_balance,
      apr: d.apr,
      hasGracePeriod: d.kind === "credit_card",
    });
    return {
      ...d,
      effectiveMinPayment: effectiveMinPayment(toDebtInput(d)),
      dueDate: stmt?.due_date ?? null,
      minimumDue: stmt?.minimum_due ?? null,
      needsDueDate: d.kind === "credit_card" && !stmt,
      statementBalance,
      statementSource: stmt?.statement_balance != null ? "statement" : "computed",
      paidThisMonth,
      remainingStatement: projection.remainingStatement,
      statementCleared: projection.statementCleared,
      projectedInterest: projection.projectedInterest,
    };
  });

  return {
    month: ctx.month,
    debts: items,
    totalBalance: roundCents(items.reduce((s, d) => s + d.current_balance, 0)),
    totalPaidThisMonth: roundCents(items.reduce((s, d) => s + d.paidThisMonth, 0)),
    totalProjectedInterest: roundCents(items.reduce((s, d) => s + d.projectedInterest, 0)),
    missingDueDates: items.filter((d) => d.needsDueDate).length,
  };
}

// ---- short-term history: spend vs payments vs interest, by month ----

export interface ShortTermMonth {
  month: string;
  /** New purchases charged to the cards/lines this month. */
  spend: number;
  /** Transfers that landed on the cards (payments made). */
  payments: number;
  /** Interest actually charged (Plaid interest-charge rows on the accounts). */
  interest: number;
}

export interface ShortTermHistory {
  months: ShortTermMonth[];
}

const INTEREST_RE = /INTEREST/i;

/**
 * Monthly history for the short-term debt bar chart: what went on the cards,
 * what was paid onto them, and what interest they charged, per month. Only
 * debts linked to a synced account contribute — the numbers come from the
 * account's own transactions.
 */
export function getShortTermHistory(ctx: EngineContext, monthCount = 12): ShortTermHistory {
  const debtAccounts = new Set(
    listDebts("active")
      .filter((d) => SHORT_TERM_KINDS.has(d.kind) && inLens(d.person_id, ctx.lens))
      .map((d) => d.account_id)
      .filter((id): id is string => id !== null),
  );
  const months = monthsBetween(addMonths(ctx.month, -(monthCount - 1)), ctx.month);
  const first = months[0]!;
  const range = { start: `${first}-01`, end: ctx.range.end };
  const byMonth = new Map<string, ShortTermMonth>(
    months.map((m) => [m, { month: m, spend: 0, payments: 0, interest: 0 }]),
  );

  // purchases + interest: the card account's own rows (Plaid amount > 0 = charge)
  for (const t of flowsForRange(range)) {
    if (!debtAccounts.has(t.accountId) || t.isTransfer || t.amount <= 0) continue;
    const bucket = byMonth.get(monthOf(t.date));
    if (!bucket) continue;
    if (INTEREST_RE.test(t.plaidDetailed ?? "") || INTEREST_RE.test(t.plaidPrimary ?? "")) {
      bucket.interest += t.amount;
    } else {
      bucket.spend += t.amount;
    }
  }

  // payments: inflow legs of marked transfers landing on the card accounts
  for (const leg of transferLegsForRange(range)) {
    if (leg.amount >= 0 || !debtAccounts.has(leg.account_id)) continue;
    const bucket = byMonth.get(monthOf(leg.date));
    if (bucket) bucket.payments += -leg.amount;
  }

  return {
    months: months.map((m) => {
      const b = byMonth.get(m)!;
      return { month: m, spend: roundCents(b.spend), payments: roundCents(b.payments), interest: roundCents(b.interest) };
    }),
  };
}

// ---- long-term screen: installment loans over the course of repayment ----

/** Normalize a recurring payment's cadence to a monthly amount. */
const MONTHLY_FACTOR: Record<string, number> = {
  weekly: 52 / 12,
  biweekly: 26 / 12,
  monthly: 1,
  quarterly: 1 / 3,
  semiannual: 1 / 6,
  annual: 1 / 12,
};

export interface LongTermDebtItem extends DebtRow {
  effectiveMinPayment: number;
  /** The amount set to pay it off in the budget (linked bills, else minimum). */
  budgetedPayment: number;
  paymentSource: "bill" | "min_payment" | "fallback";
  /** Null when the budgeted payment can't retire the debt (≤ monthly interest). */
  schedule: { monthsToFree: number; payoffMonth: string; totalInterest: number } | null;
}

export interface LongTermDebtView {
  month: string;
  debts: LongTermDebtItem[];
  totalBalance: number;
  totalMonthlyPayment: number;
  /** Σ interest over the full course of repayment (retirable debts only). */
  totalInterest: number;
}

export function getLongTermDebtView(ctx: EngineContext): LongTermDebtView {
  const debts = listDebts("active").filter(
    (d) => !SHORT_TERM_KINDS.has(d.kind) && inLens(d.person_id, ctx.lens),
  );

  const billsByDebt = new Map<string, number>();
  for (const rp of listRecurring("active")) {
    if (!rp.debt_id) continue;
    const factor =
      rp.frequency === "custom"
        ? rp.interval_days && rp.interval_days > 0
          ? 30.44 / rp.interval_days
          : 1
        : (MONTHLY_FACTOR[rp.frequency] ?? 1);
    billsByDebt.set(
      rp.debt_id,
      roundCents((billsByDebt.get(rp.debt_id) ?? 0) + rp.expected_amount * factor),
    );
  }

  const items = debts.map((d): LongTermDebtItem => {
    const bill = billsByDebt.get(d.debt_id);
    const budgetedPayment = bill ?? d.min_payment ?? effectiveMinPayment(toDebtInput(d));
    const paymentSource: LongTermDebtItem["paymentSource"] =
      bill != null ? "bill" : d.min_payment != null ? "min_payment" : "fallback";
    const schedule = repaymentSchedule(toDebtInput(d), budgetedPayment, addMonths(ctx.month, 1));
    return {
      ...d,
      effectiveMinPayment: effectiveMinPayment(toDebtInput(d)),
      budgetedPayment: roundCents(budgetedPayment),
      paymentSource,
      schedule: schedule
        ? {
            monthsToFree: schedule.monthsToFree,
            payoffMonth: schedule.payoffMonth,
            totalInterest: schedule.totalInterest,
          }
        : null,
    };
  });

  return {
    month: ctx.month,
    debts: items,
    totalBalance: roundCents(items.reduce((s, d) => s + d.current_balance, 0)),
    totalMonthlyPayment: roundCents(items.reduce((s, d) => s + d.budgetedPayment, 0)),
    totalInterest: roundCents(items.reduce((s, d) => s + (d.schedule?.totalInterest ?? 0), 0)),
  };
}

// ---- statement upsert (pay-by dates) ----

export interface DebtStatementInput {
  month: string; // YYYY-MM
  dueDate: string; // YYYY-MM-DD
  statementBalance?: number | null;
  minimumDue?: number | null;
}

export function setDebtStatement(debtId: string, input: DebtStatementInput): DebtStatementRow | undefined {
  if (!getDebt(debtId)) return undefined;
  const row: DebtStatementRow = {
    debt_id: debtId,
    month: input.month,
    due_date: input.dueDate,
    statement_balance: input.statementBalance ?? null,
    minimum_due: input.minimumDue ?? null,
    created_at: new Date().toISOString(),
  };
  upsertDebtStatement(row);
  return row;
}
