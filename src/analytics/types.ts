/**
 * analytics/types.ts — shared domain types for the pure analytics layer.
 * Leaf module: imports nothing, imported by everything in analytics/.
 * Analytics functions receive plain rows shaped like these — they never
 * import from db/, so services adapt repository rows into these shapes.
 */

/** 'YYYY-MM-DD' */
export type DateISO = string;
/** 'YYYY-MM' */
export type MonthISO = string;

/** Inclusive date range. */
export interface DateRange {
  start: DateISO;
  end: DateISO;
}

/** A person_id, or 'combined' for the household view. */
export type Lens = string;
export const COMBINED: Lens = "combined";

export interface TimePoint {
  date: DateISO;
  value: number;
}

export type CategoryKind = "income" | "expense" | "savings" | "transfer";

export interface CategoryNode {
  categoryId: string;
  parentId: string | null;
  name: string;
  kind: CategoryKind;
  sortOrder: number;
}

/**
 * A transaction as analytics sees it. `amount` keeps Plaid's sign convention
 * (positive = money leaving the account); use money.signedFlow() to get the
 * engine convention (inflow > 0). `personId` is already resolved from the
 * owning account (null = joint).
 */
export interface FlowTx {
  transactionId: string;
  accountId: string;
  personId: string | null;
  amount: number;
  currency: string | null;
  date: DateISO;
  merchantName: string | null;
  payee: string | null;
  categoryId: string | null;
  categorizationSource: "plaid" | "rule" | "manual";
  plaidPrimary: string | null;
  plaidDetailed: string | null;
  isTransfer: boolean;
  reimbursedBy: "work" | "buildings" | null;
  /** Spending tagged to a goal draws from the goal's envelope, not the budget. */
  goalId?: string | null;
  /** Optional goal subcategory (line item) the spend counts against. */
  goalLineId?: string | null;
  pending: boolean;
}

export interface SankeyNode {
  name: string;
}

export interface SankeyLink {
  source: string;
  target: string;
  value: number;
}

/** Maps directly onto ECharts `series-sankey` data/links. */
export interface SankeyGraph {
  nodes: SankeyNode[];
  links: SankeyLink[];
}

export interface HeatmapCell {
  month: MonthISO;
  categoryId: string;
  value: number;
}

/** Row of fx_rates as analytics consumes it. */
export interface FxRate {
  date: DateISO;
  baseCcy: string;
  quoteCcy: string;
  rate: number;
}

export type Frequency =
  | "weekly"
  | "biweekly"
  | "monthly"
  | "quarterly"
  | "semiannual"
  | "annual"
  | "custom";
