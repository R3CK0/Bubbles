/**
 * server/contracts.ts — the API type contract shared with the frontend.
 * Routes validate bodies with these zod schemas; response types compose from
 * analytics types. The web app imports this module (types + schemas only, no
 * server runtime) so the fetch layer stays compile-time-checked.
 * Grows with each engine step; this is the step-1 slice.
 */
import { z } from "zod";
import type {
  CashflowSummary,
  FluxMatrix,
  SankeyGraph,
  VarianceDriver,
  BudgetVsActualRow,
} from "../analytics/index.js";
import type { CategoryDrilldown } from "../engine/cashflowService.js";
import type { BudgetView, CategoryVarianceNarrative } from "../engine/budgetService.js";
import type { InboxCard } from "../engine/categorizationService.js";
import type { CategoryRow, BudgetVersionRow } from "../db/repositories/budgeting.js";

// ---- Cashflow ----
export type CashflowSummaryResponse = CashflowSummary;
export type SankeyResponse = SankeyGraph;
export type FluxResponse = FluxMatrix;
export type CategoryDrilldownResponse = CategoryDrilldown;

// ---- Budget ----
export type BudgetViewResponse = BudgetView;
export type BudgetVarianceResponse = { narratives: CategoryVarianceNarrative[] };
export type BudgetVersionsResponse = { versions: BudgetVersionRow[] };
export type { BudgetVsActualRow, VarianceDriver };

export const budgetUpdateSchema = z
  .object({
    effectiveFrom: z.string().regex(/^\d{4}-\d{2}$/),
    name: z.string().min(1).optional(),
    lines: z
      .array(
        z.object({
          categoryId: z.string().min(1),
          personId: z.string().min(1).nullable(),
          monthlyAmount: z.number().min(0),
        }),
      )
      .min(1),
  })
  .strict();
export type BudgetUpdateBody = z.infer<typeof budgetUpdateSchema>;

/** Clear the whole budget from a month onward (new empty version). */
export const budgetResetSchema = z
  .object({
    effectiveFrom: z.string().regex(/^\d{4}-\d{2}$/),
    name: z.string().min(1).optional(),
  })
  .strict();
export type BudgetResetBody = z.infer<typeof budgetResetSchema>;

// ---- Categories & rules ----
export type CategoriesResponse = { categories: CategoryRow[] };

export const categorySchema = z
  .object({
    categoryId: z.string().min(1),
    parentId: z.string().min(1).nullable(),
    name: z.string().min(1),
    kind: z.enum(["income", "expense", "savings", "transfer"]),
    sortOrder: z.number().int().default(0),
    archived: z.boolean().default(false),
  })
  .strict();
export type CategoryBody = z.infer<typeof categorySchema>;

export const ruleSchema = z
  .object({
    ruleId: z.string().min(1).optional(),
    priority: z.number().int().min(1),
    merchantPattern: z.string().min(1).nullable().optional(),
    payeePattern: z.string().min(1).nullable().optional(),
    plaidCategory: z.string().min(1).nullable().optional(),
    accountId: z.string().min(1).nullable().optional(),
    amountMin: z.number().nullable().optional(),
    amountMax: z.number().nullable().optional(),
    categoryId: z.string().min(1).nullable().optional(),
    goalId: z.string().min(1).nullable().optional(),
    goalLineId: z.string().min(1).nullable().optional(),
    /** Locked mappings apply to all future transactions and can only be deleted. */
    lock: z.boolean().optional(),
    active: z.boolean().optional(),
    retroactiveMonths: z.number().int().min(0).max(60).default(0),
  })
  .strict()
  .refine((r) => r.categoryId || r.goalId, { message: "a rule needs a category or a goal target" });
export type RuleBody = z.infer<typeof ruleSchema>;

export type InboxResponse = { count: number; cards: InboxCard[] };

export const categorizeSchema = z
  .object({ categoryId: z.string().min(1).nullable() })
  .strict();
export type CategorizeBody = z.infer<typeof categorizeSchema>;

/** Inbox → flag a charge as a recurring expense; it confirms itself when the
 *  next matching charge arrives. */
export const recurringFlagSchema = z
  .object({
    frequency: z.enum(["weekly", "biweekly", "monthly", "quarterly", "semiannual", "annual"]),
    name: z.string().min(1).optional(),
  })
  .strict();
export type RecurringFlagBody = z.infer<typeof recurringFlagSchema>;

/** Budget-exclusion flags: expense-report reimbursements and goal spending. */
export const transactionFlagsSchema = z
  .object({
    reimbursedBy: z.enum(["work", "buildings"]).nullable().optional(),
    goalId: z.string().min(1).nullable().optional(),
    goalLineId: z.string().min(1).nullable().optional(),
  })
  .strict();
export type TransactionFlagsBody = z.infer<typeof transactionFlagsSchema>;

// ---- AI categorization review ----
export const aiSuggestSchema = z
  .object({ transactionId: z.string().min(1).optional() })
  .strict();

export const aiApplySchema = z
  .object({
    transactionId: z.string().min(1),
    target: z.enum(["budget", "goal"]),
    categoryId: z.string().min(1).nullable().optional(),
    goalId: z.string().min(1).nullable().optional(),
    goalLineId: z.string().min(1).nullable().optional(),
    /** Lock the merchant→target mapping for all future transactions. */
    lock: z.boolean().default(true),
    merchantPattern: z.string().min(1).nullable().optional(),
  })
  .strict()
  .refine((b) => (b.target === "budget" ? !!b.categoryId : !!b.goalId), {
    message: "budget target needs categoryId; goal target needs goalId",
  });
export type AiApplyBody = z.infer<typeof aiApplySchema>;

/** Account Flows diagram: user-arranged card positions, keyed by account id. */
export const flowLayoutSchema = z
  .object({
    layout: z.record(
      z.string().min(1),
      z.object({ x: z.number().min(0).max(10000), y: z.number().min(0).max(10000) }).strict(),
    ),
  })
  .strict();
export type FlowLayoutBody = z.infer<typeof flowLayoutSchema>;

// ---- Bills & recurring (step 2) ----
export const recurringSchema = z
  .object({
    name: z.string().min(1),
    categoryId: z.string().min(1).nullable().optional(),
    personId: z.string().min(1).nullable().optional(),
    accountId: z.string().min(1).nullable().optional(),
    expectedAmount: z.number().positive(),
    amountTolerance: z.number().min(0).max(1).optional(),
    frequency: z.enum(["weekly", "biweekly", "monthly", "quarterly", "semiannual", "annual", "custom"]),
    intervalDays: z.number().int().positive().nullable().optional(),
    anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    autopay: z.boolean().optional(),
    reimbursedBy: z.enum(["work", "buildings"]).nullable().optional(),
    debtId: z.string().min(1).nullable().optional(),
  })
  .strict();
export type RecurringBody = z.infer<typeof recurringSchema>;

/** Bills → edit category: retargets the bill AND its merchant mapping. */
export const billCategorySchema = z
  .object({
    categoryId: z.string().min(1),
    retroactiveMonths: z.number().int().min(0).max(60).default(12),
  })
  .strict();
export type BillCategoryBody = z.infer<typeof billCategorySchema>;

// ---- Debts (step 2) ----
export const debtCreateSchema = z
  .object({
    personId: z.string().min(1).nullable().optional(),
    accountId: z.string().min(1).nullable().optional(),
    name: z.string().min(1),
    kind: z.enum(["credit_card", "student_loan", "line_of_credit", "auto_loan", "mortgage", "personal", "other"]),
    originalPrincipal: z.number().positive().nullable().optional(),
    currentBalance: z.number().min(0),
    apr: z.number().min(0).max(100),
    minPayment: z.number().positive().nullable().optional(),
    paymentDay: z.number().int().min(1).max(31).nullable().optional(),
    maturityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  })
  .strict();
export type DebtCreateBody = z.infer<typeof debtCreateSchema>;

// ---- Wealth & planning (step 3) ----
export const manualAssetSchema = z
  .object({
    name: z.string().min(1),
    assetClass: z.enum(["real_estate", "vehicle", "private_equity", "collectible", "other"]),
    personId: z.string().min(1).nullable().optional(),
    currency: z.string().length(3).optional(),
    notes: z.string().nullable().optional(),
    initialValue: z.number().min(0).optional(),
  })
  .strict();

export const valuationSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    value: z.number().min(0),
    source: z.string().nullable().optional(),
  })
  .strict();

export const allocationTargetsSchema = z.record(z.string(), z.number().min(0).max(1));

export const goalCreateSchema = z
  .object({
    goalType: z.enum(["house", "kid", "trip", "purchase", "savings", "event", "emergency_fund", "debt_payoff"]),
    category: z.enum(["saving", "spending", "loan"]),
    name: z.string().min(1),
    personId: z.string().min(1).nullable().optional(),
    // For loan goals this is the balance to reduce TO, so 0 (paid off) is valid.
    targetAmount: z.number().min(0),
    targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    priority: z.number().int().min(1).max(5).optional(),
    linkedAccountId: z.string().min(1).nullable().optional(),
    linkedDebtId: z.string().min(1).nullable().optional(),
    fundedAmount: z.number().min(0).optional(),
    params: z.unknown().optional(),
    notes: z.string().nullable().optional(),
  })
  .strict()
  .superRefine((g, ctx) => {
    if (g.category === "saving" && !g.linkedAccountId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["linkedAccountId"], message: "a saving goal tracks an account — pick one" });
    }
    if (g.category === "loan" && !g.linkedAccountId && !g.linkedDebtId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["linkedDebtId"], message: "a loan goal tracks a debt or account — pick one" });
    }
    if (g.category === "loan" && !g.targetDate) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["targetDate"], message: "a loan goal needs a payoff date" });
    }
    if (g.category !== "loan" && g.targetAmount <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["targetAmount"], message: "target amount must be positive" });
    }
  });

export const goalPatchSchema = z
  .object({
    name: z.string().min(1).optional(),
    targetAmount: z.number().positive().optional(),
    targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    priority: z.number().int().min(1).max(5).optional(),
    personId: z.string().min(1).nullable().optional(),
    linkedAccountId: z.string().min(1).nullable().optional(),
    fundedAmount: z.number().min(0).optional(),
    status: z.enum(["active", "achieved", "abandoned", "paused"]).optional(),
    notes: z.string().nullable().optional(),
    params: z.unknown().optional(),
  })
  .strict();

export const lineItemSchema = z
  .object({
    lineId: z.string().min(1).optional(),
    name: z.string().min(1),
    amount: z.number().positive(),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    status: z.enum(["planned", "deposit_paid", "paid", "cancelled"]).optional(),
    transactionId: z.string().min(1).nullable().optional(),
  })
  .strict();

export const solveOverridesSchema = z
  .object({
    freeCashFlowMonthly: z.number().optional(),
    bufferTarget: z.number().min(0).optional(),
    goalShifts: z
      .array(
        z.object({
          goalId: z.string().min(1),
          targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
        }),
      )
      .optional(),
  })
  .strict();

export const planApproveSchema = z
  .object({ name: z.string().min(1), overrides: solveOverridesSchema.optional() })
  .strict();

export const scenarioSchema = z
  .object({
    name: z.string().min(1),
    params: z
      .object({
        freeCashFlowDelta: z.number().optional(),
        bufferTarget: z.number().min(0).optional(),
        goalShifts: z
          .array(z.object({ goalId: z.string().min(1), targetDate: z.string().nullable() }))
          .optional(),
      })
      .strict(),
    notes: z.string().nullable().optional(),
  })
  .strict();

// ---- Manual positions (portfolio state is user-maintained) ----
export const positionSchema = z
  .object({
    accountId: z.string().min(1),
    symbol: z.string().min(1).nullable().optional(),
    name: z.string().min(1),
    assetType: z.enum(["stock", "etf", "crypto", "option", "cash", "other"]),
    quantity: z.number().min(0),
    bookCost: z.number().min(0).nullable().optional(),
    manualValue: z.number().min(0).nullable().optional(),
    currency: z.string().length(3).optional(),
    effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .strict()
  .refine((p) => p.symbol || p.manualValue !== undefined, {
    message: "either a market symbol or a manualValue is required",
  });
export type PositionBody = z.infer<typeof positionSchema>;

// ---- Tax & ops (step 4) ----
export const optimizeSchema = z
  .object({
    deployableCash: z.number().min(0),
    year: z.number().int().min(2026).max(2100),
  })
  .strict();

export const optimizeAcceptSchema = optimizeSchema
  .extend({ planName: z.string().min(1) })
  .strict();

export const roomUpdateSchema = z
  .object({
    rooms: z
      .array(
        z.object({
          personId: z.string().min(1),
          accountType: z.enum(["FHSA", "TFSA", "RRSP"]),
          taxYear: z.number().int().min(2026).max(2100),
          roomAmount: z.number().min(0),
          source: z.string().nullable().optional(),
        }),
      )
      .min(1),
  })
  .strict();

export const taxProfileSchema = z
  .object({
    personId: z.string().min(1),
    taxYear: z.number().int().min(2026).max(2100),
    employmentIncome: z.number().min(0).optional(),
    withholdingPaid: z.number().min(0).optional(),
    /** Weekly net deposit — drives the after-tax budget + paycheque-deduction analysis. */
    weeklyTakeHome: z.number().min(0).nullable().optional(),
    otherIncome: z
      .object({
        interest: z.number().min(0).optional(),
        eligibleDividends: z.number().min(0).optional(),
        capitalGains: z.number().optional(),
        /** Manual net rental income — used until Buildings tracking supplies it. */
        rentalNet: z.number().min(0).optional(),
        donations: z.number().min(0).optional(),
        medicalExpenses: z.number().min(0).optional(),
      })
      .strict()
      .optional(),
    carryforwards: z.unknown().optional(),
  })
  .strict();

export const decisionSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    title: z.string().min(1),
    body: z.string().nullable().optional(),
    links: z.unknown().optional(),
  })
  .strict();

export const settingsSchema = z
  .object({
    buffer_floor: z.coerce.number().min(0).optional(),
    buffer_target: z.coerce.number().min(0).optional(),
    base_currency: z.string().length(3).optional(),
  })
  .strict();

export const debtPatchSchema = z
  .object({
    name: z.string().min(1).optional(),
    /** Changing kind moves the debt between the short-term and long-term screens. */
    kind: z.enum(["credit_card", "student_loan", "line_of_credit", "auto_loan", "mortgage", "personal", "other"]).optional(),
    currentBalance: z.number().min(0).optional(),
    apr: z.number().min(0).max(100).optional(),
    minPayment: z.number().positive().nullable().optional(),
    paymentDay: z.number().int().min(1).max(31).nullable().optional(),
    maturityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    status: z.enum(["active", "paid_off", "archived"]).optional(),
    personId: z.string().min(1).nullable().optional(),
    accountId: z.string().min(1).nullable().optional(),
  })
  .strict();
export type DebtPatchBody = z.infer<typeof debtPatchSchema>;

/** Monthly statement entry — credit cards require one per month (pay-by date). */
export const debtStatementSchema = z
  .object({
    month: z.string().regex(/^\d{4}-\d{2}$/),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    statementBalance: z.number().min(0).nullable().optional(),
    minimumDue: z.number().min(0).nullable().optional(),
  })
  .strict();
export type DebtStatementBody = z.infer<typeof debtStatementSchema>;
