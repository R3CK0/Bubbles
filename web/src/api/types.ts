/**
 * API response types — hand-mirrored from src/server/contracts.ts and the
 * engine services (the backend contracts module imports server code, so the
 * web app keeps its own copy of the slices it renders).
 */

// ---- shared ----
export interface TimePoint { date: string; value: number }
export type CategoryKind = "income" | "expense" | "savings" | "transfer";

export interface Person { person_id: string; display_name: string; color: string | null; created_at: string }

// ---- overview ----
export interface Alert {
  alert_id: string; alert_type: string; severity: "info" | "warning" | "critical";
  title: string; body: string | null; created_at: string; acknowledged_at: string | null;
}
export interface BillDay { date: string; items: { rpId: string; name: string; amount: number; personId: string | null }[]; total: number }
export interface LowWindow { start: string; end: string; minBalance: number }
export interface Milestone { date: string; value: number }
export interface Hero { current: number; monthDelta: number | null; spark90d: TimePoint[]; lastMilestone: Milestone | null }
export interface CashflowSummary { income: number; spend: number; net: number; byCategory: CategoryAmount[] }
export interface CategoryAmount { categoryId: string | null; name: string; kind: CategoryKind | "uncategorized"; parentId: string | null; amount: number }
export interface Overview {
  hero: Hero; cashflow: CashflowSummary;
  goals: { goalId: string; name: string; progress: number; feasible: "yes" | "tight" | "no" }[];
  next7Days: BillDay[]; lowWindows: LowWindow[]; alerts: Alert[]; uncategorized: number; lastSync: string | null;
}

// ---- cashflow ----
export interface SankeyGraph { nodes: { name: string }[]; links: { source: string; target: string; value: number }[] }
export interface FluxMatrix { months: string[]; categories: { categoryId: string; name: string; kind: CategoryKind }[]; cells: { month: string; categoryId: string; value: number }[] }
export interface VarianceDriver { kind: string; merchant: string; delta: number; detail: string }
export interface ExcludedSummary {
  reimbursed: { work: { spent: number; repaid: number }; buildings: { spent: number; repaid: number } };
  goals: { goalId: string; name: string; spent: number }[];
}

export interface IncomeBreakdown {
  month: string;
  total: number;
  sources: {
    name: string;
    total: number;
    accounts: {
      accountId: string;
      accountName: string;
      mask: string | null;
      amount: number;
      deposits: { transactionId: string; date: string; amount: number; merchant: string | null }[];
    }[];
  }[];
}

// ---- account flows ----
export interface FlowAccount {
  accountId: string; name: string; mask: string | null; personId: string | null;
  type: string | null; subtype: string | null; registeredType: string | null; debtLinked: boolean;
}
export interface AccountFlow {
  fromAccountId: string; toAccountId: string; total: number; count: number;
  kind: "debt" | "save" | "move"; items: { date: string; amount: number }[];
}
export interface AccountFlowsView {
  month: string; totalMoved: number; debtPayments: number; toSavings: number; transferCount: number;
  accounts: FlowAccount[]; flows: AccountFlow[];
}
export type FlowLayout = Record<string, { x: number; y: number }>;

export interface CategoryDrilldown {
  categoryId: string; month: string; total: number;
  transactions: { transactionId: string; date: string; merchant: string | null; amount: number; pending: boolean }[];
  trend: { month: string; value: number }[]; drivers: VarianceDriver[];
}

// ---- budget ----
export interface BudgetVersion { version_id: string; name: string; effective_from: string; created_at: string; notes: string | null }
export interface BudgetRow {
  categoryId: string; name: string; kind: CategoryKind; parentId: string | null;
  budget: number; actual: number; variance: number; pace: number | null;
}
export interface BudgetView { version: BudgetVersion | null; month: string; dayFraction: number; rows: BudgetRow[] }
export interface VarianceNarrative { categoryId: string; name: string; variance: number; drivers: VarianceDriver[] }
export interface Category { category_id: string; parent_id: string | null; name: string; kind: CategoryKind; sort_order: number; archived: number }
export interface Rule {
  rule_id: string; priority: number; merchant_pattern: string | null; payee_pattern: string | null;
  plaid_category: string | null; account_id: string | null; amount_min: number | null; amount_max: number | null;
  category_id: string | null; goal_id: string | null; goal_line_id: string | null;
  source: "manual" | "ai"; locked_at: string | null; active: number;
}
export interface InboxCard {
  transaction: { transactionId: string; date: string; merchant: string | null; amount: number; plaidPrimary: string | null };
  suggestedCategoryId: string | null;
}

// ---- transactions page ----
export interface TransactionListItem {
  transactionId: string; date: string; merchant: string | null;
  /** Signed flow: positive = money in. */
  amount: number; pending: boolean;
  accountId: string; accountName: string; accountMask: string | null; personId: string | null;
  categoryId: string | null; categorizationSource: "plaid" | "rule" | "manual";
  plaidPrimary: string | null; isTransfer: boolean;
  /** Marked as a transfer but the counterpart hasn't been found yet. */
  transferPending: boolean;
  reimbursedBy: "work" | "buildings" | null; goalId: string | null;
}

/** POST /api/transactions/:id/transfer */
export interface TransferMarkResult { marked: boolean; matched: boolean }
/** POST /api/transactions/:id/recurring */
export interface RecurringFlagResult { recurring: Recurring; alreadyTracked: boolean }
export interface TransactionsListView {
  month: string; count: number; totalIn: number; totalOut: number;
  transactions: TransactionListItem[];
}

// ---- AI expense review ----
export interface AiStatus { enabled: boolean; model: string }
export interface AiSuggestion {
  target: "budget" | "goal" | "unknown";
  categoryId: string | null; goalId: string | null; goalLineId: string | null;
  confidence: number; reason: string; alwaysAsk: boolean;
  newSubcategoryName: string | null; newSubcategoryParentId: string | null;
}
export interface AiReviewCard {
  transaction: { transactionId: string; date: string; merchant: string | null; amount: number; plaidPrimary: string | null; plaidDetailed: string | null };
  suggestion: AiSuggestion; willLock: boolean; remaining: number;
}
export interface AiApplyResult { applied: boolean; locked: boolean; lockedReason: string | null }

// ---- bills ----
export type Frequency = "weekly" | "biweekly" | "monthly" | "quarterly" | "semiannual" | "annual" | "custom";
export interface Recurring {
  rp_id: string; name: string; category_id: string | null; person_id: string | null; account_id: string | null;
  expected_amount: number; amount_tolerance: number; currency: string; frequency: Frequency;
  interval_days: number | null; anchor_date: string; next_due_date: string; end_date: string | null;
  autopay: number; reimbursed_by: "work" | "buildings" | null; debt_id: string | null;
  source: "manual" | "detected"; status: "active" | "paused" | "ended" | "proposed"; created_at: string;
}
export interface RegistryItem extends Recurring { priceHistory: { date: string; amount: number }[] }
export interface BillsCalendar {
  month: string; days: BillDay[]; projection: TimePoint[]; lowWindows: LowWindow[];
  bufferFloor: number; startBalance: number;
}

// ---- debts ----
export interface Debt {
  debt_id: string; person_id: string | null; account_id: string | null; name: string;
  kind: "credit_card" | "student_loan" | "line_of_credit" | "auto_loan" | "mortgage" | "personal" | "other";
  original_principal: number | null; current_balance: number; apr: number; min_payment: number | null;
  payment_day: number | null; maturity_date: string | null; status: "active" | "paid_off" | "archived";
}
export interface DebtOverview { debts: (Debt & { effectiveMinPayment: number; rateHistory: { effective_date: string; apr: number }[] })[]; totalBalance: number; totalMinPayments: number }
export interface PayoffPlan {
  strategy: "avalanche" | "snowball"; months: string[];
  perDebt: { debtId: string; name: string; balances: number[] }[];
  totalInterest: number; monthsToFree: number; debtFreeMonth: string | null;
}
export interface StrategyComparison { avalanche: PayoffPlan; snowball: PayoffPlan; monthsSaved: number; interestSaved: number }

export interface ShortTermDebtItem extends Debt {
  effectiveMinPayment: number;
  dueDate: string | null;
  minimumDue: number | null;
  needsDueDate: boolean;
  statementBalance: number;
  statementSource: "statement" | "computed";
  paidThisMonth: number;
  remainingStatement: number;
  statementCleared: boolean;
  projectedInterest: number;
}
export interface ShortTermDebtView {
  month: string; debts: ShortTermDebtItem[];
  totalBalance: number; totalPaidThisMonth: number; totalProjectedInterest: number; missingDueDates: number;
}

export interface ShortTermMonth { month: string; spend: number; payments: number; interest: number }
export interface ShortTermHistory { months: ShortTermMonth[] }

export interface LongTermDebtItem extends Debt {
  effectiveMinPayment: number;
  budgetedPayment: number;
  paymentSource: "bill" | "min_payment" | "fallback";
  schedule: { monthsToFree: number; payoffMonth: string; totalInterest: number } | null;
}
export interface LongTermDebtView {
  month: string; debts: LongTermDebtItem[];
  totalBalance: number; totalMonthlyPayment: number; totalInterest: number;
}

// ---- net worth ----
export interface NetWorthSeries { dates: string[]; assets: TimePoint[]; debts: TimePoint[]; net: TimePoint[]; milestones: Milestone[] }
export interface BreakdownEntry { label: string; value: number; kind: "account" | "manual_asset" | "manual_debt"; liability: boolean }
export interface EmergencyFund { liquidBalance: number; essentialsMonthlyAvg: number; months: number | null }

// ---- portfolio ----
export interface Decomposition { contributions: TimePoint[]; growth: TimePoint[] }
export interface PortfolioSeries { series: TimePoint[]; decomposition: Decomposition | null }
export interface Holding {
  securityId: string; ticker: string | null; name: string | null; secType: string | null;
  quantity: number; value: number; costBasis: number | null; gain: number | null; weight: number; spark30d: TimePoint[];
}
export interface AllocationSlice { class: string; value: number; weight: number; target: number | null; drift: number | null }
export interface Performance { twr: number | null; mwr: number | null; dividendsByMonth: { month: string; value: number }[] }
export interface ManualAsset {
  asset_id: string; name: string; asset_class: string; person_id: string | null; currency: string; notes: string | null;
  valuations: { date: string; value: number; source: string | null }[];
}
export interface BuildingsPnl { asset: ManualAsset | null; incomeByMonth: { month: string; value: number }[]; expensesByMonth: { month: string; value: number }[]; netByMonth: { month: string; value: number }[] }
export interface Position {
  position_id: string; account_id: string; symbol: string | null; name: string;
  asset_type: "stock" | "etf" | "crypto" | "option" | "cash" | "other";
  quantity: number; book_cost: number | null; manual_value: number | null; currency: string;
  lastPrice: number | null; currentValue: number;
}
export interface AccountPositions {
  accountId: string; accountName: string | null; registeredType: string | null; personId: string | null;
  positions: Position[]; computedTotal: number; reportedBalance: number | null; drift: number | null;
}

// ---- goals ----
export interface GoalLineItem { line_id: string; goal_id: string; name: string; amount: number; due_date: string | null; status: "planned" | "deposit_paid" | "paid" | "cancelled"; transaction_id: string | null; spent: number }
export type GoalCategory = "saving" | "spending" | "loan";
export interface Goal {
  goal_id: string; goal_type: "house" | "kid" | "trip" | "purchase" | "savings" | "event" | "emergency_fund" | "debt_payoff";
  category: GoalCategory;
  name: string; person_id: string | null; target_amount: number; target_date: string | null; priority: number;
  linked_account_id: string | null; linked_debt_id: string | null; funded_amount: number;
  status: "active" | "achieved" | "abandoned" | "paused"; notes: string | null;
  progress: number; requiredMonthly: number | null; lineItems: GoalLineItem[];
  /** Loan goals: linked debt/account balance still owed. */
  currentBalance: number | null;
  /** Loan goals: the reduce-to balance (target_amount holds the normalized total paydown). */
  targetBalance: number | null;
  eventBudget: { committed: number; paid: number; remaining: number } | null;
  taggedSpend: { total: number; month: number };
}
export interface GoalOptions {
  accounts: { accountId: string; name: string; type: string | null; currentBalance: number | null }[];
  debts: { debtId: string; name: string; currentBalance: number }[];
}
export interface GoalVerdict { goalId: string; name: string; feasible: "yes" | "tight" | "no"; fundedBy: string | null; gap: number; requiredMonthly: number | null }
export interface SolveResult {
  schedule: { month: string; targetType: string; targetId: string | null; personId: string | null; amount: number; reason: string }[];
  perGoal: GoalVerdict[]; collisions: string[]; unallocatedMonthly: { month: string; amount: number }[];
  suggestions?: { categoryId: string; name: string; cutMonthly: number; covers: string }[];
}
export interface GoalsView { goals: Goal[]; solve: SolveResult }
export interface Scenario { scenario_id: string; name: string; params_json: string | null; notes: string | null; created_at: string }
export interface PlanRow { plan_id: string; name: string; status: string; created_at: string }
export interface PlanLine { plan_id: string; month: string; person_id: string | null; target_type: string; target_id: string | null; amount: number }

// ---- tax ----
export interface JurisdictionResult { taxableIncome: number; grossTax: number; credits: number; netTax: number }
export interface TaxResult {
  personId: string; taxYear: number; totalIncome: number; taxableIncome: number;
  federal: JurisdictionResult; quebec: JurisdictionResult;
  payroll: { qpp: number; qpip: number; ei: number; total: number };
  totalIncomeTax: number; marginalRate: number; averageRate: number; withheld: number; balance: number;
}
export interface BracketFill { jurisdiction: "CA" | "QC"; tiers: { upTo: number | null; rate: number; filled: number; capacity: number | null }[] }
export interface TaxEstimate {
  year: number; perPerson: (TaxResult & { glasses: BracketFill[] })[];
  household: { totalIncome: number; totalIncomeTax: number; totalPayroll: number; balance: number; averageRate: number };
  scopeExclusions: string[];
}
export interface RoomView { personId: string; accountType: "FHSA" | "TFSA" | "RRSP"; taxYear: number; room: number; contributed: number; remaining: number; asOf: string | null }
export interface OptimizerResult {
  allocations: { personId: string; fhsa: number; rrsp: number; tfsa: number; taxSaved: number; reasons: string[] }[];
  totalTaxSaved: number; totalDeployed: number;
  monthlySchedule: { personId: string; type: "fhsa" | "rrsp" | "tfsa"; monthly: number }[];
}
export interface CoupleStrategy { kind: string; title: string; description: string; dollarImpact: number; actions: string[]; caveats: string[] }
export interface TaxProfile {
  person_id: string; tax_year: number; employment_income: number | null; withholding_paid: number | null;
  other_income_json: string | null; carryforwards_json: string | null; weekly_take_home: number | null;
}

// ---- review / ops ----
export interface ReviewSlide { kind: "cashflow" | "categories" | "variances" | "goals" | "networth" | "ahead" | "decisions"; title: string; data: unknown }
export interface Report { report_id: string; report_type: string; period_start: string; title: string | null; created_at: string; data_json: string | null }
export interface Decision { decision_id: string; date: string; title: string; body: string | null }
export interface Settings { buffer_floor: string | null; buffer_target: string | null; base_currency: string | null; allocation_targets: string | null }
export interface VaultStatus { initialized: boolean; unlocked: boolean; session: { valid: boolean; expiresAt?: string } | null }

// ---- Plaid tier ----
export interface Item { item_id: string; institution_id: string | null; institution_name: string | null; linked_at: string; last_synced_at: string | null }
export interface ApiAccount {
  accountId: string; itemId: string; name: string | null; officialName: string | null; mask: string | null;
  type: string | null; subtype: string | null; currentBalance: number | null; availableBalance: number | null;
  currency: string | null; personId: string | null; registeredType: string | null; purpose: string | null;
  tracked: boolean; isClosed: boolean; classifiedAt: string | null; updatedAt: string;
}
export interface SyncResult { added?: number; modified?: number; removed?: number; [k: string]: unknown }
