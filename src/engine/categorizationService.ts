/**
 * engine/categorizationService.ts — rules lifecycle, the uncategorized inbox,
 * and the transfer sweep. The write path enforces manual-wins via the repo.
 */
import { randomUUID } from "node:crypto";
import {
  applyRules,
  applyGoalRules,
  suggestCategory,
  signedFlow,
  addDays,
  addMonths,
  dayDiff,
  monthOf,
  type CategoryRule,
  type FlowTx,
} from "../analytics/index.js";
import {
  bulkApplyCategoryPatches,
  bulkApplyGoalPatches,
  clearTransferMark,
  flowsForRange,
  getFlowTx,
  listPendingTransferLegs,
  listRules,
  listUncategorized,
  markTransferPair,
  setPendingTransfer,
  setTransactionCategory,
  toCategoryRule,
  upsertRule,
  uncategorizedCount,
  deleteRule as repoDeleteRule,
  type CategoryRuleRow,
} from "../db/repositories/budgeting.js";
import { adoptRecurringCategory } from "../db/repositories/recurring.js";
import { createAlert } from "../db/repositories/ops.js";
import { listAccounts } from "../db/repository.js";
import { inLens } from "../analytics/cashflow.js";
import type { EngineContext } from "./context.js";

function loadRules(): CategoryRule[] {
  return listRules().map(toCategoryRule);
}

/** Apply active rules across a date range (nightly + retroactive re-runs). */
export function categorizeRange(range: { start: string; end: string }): number {
  const flows = flowsForRange(range);
  const rules = loadRules();
  const applied = bulkApplyCategoryPatches(applyRules(flows, rules), "rule");
  const goalTagged = bulkApplyGoalPatches(applyGoalRules(flows, rules));
  return applied + goalTagged;
}

export interface RuleInput {
  ruleId?: string;
  priority: number;
  merchantPattern?: string | null;
  payeePattern?: string | null;
  plaidCategory?: string | null;
  accountId?: string | null;
  amountMin?: number | null;
  amountMax?: number | null;
  categoryId?: string | null;
  goalId?: string | null;
  goalLineId?: string | null;
  source?: "manual" | "ai";
  /** Lock the mapping: it applies to all future transactions and can only be deleted, never edited. */
  lock?: boolean;
  active?: boolean;
}

export function saveRule(input: RuleInput, retroactiveMonths = 0): { ruleId: string; applied: number } {
  if (!input.categoryId && !input.goalId) {
    throw Object.assign(new Error("a rule needs a category or a goal target"), { status: 400 });
  }
  const row: CategoryRuleRow = {
    rule_id: input.ruleId ?? randomUUID(),
    priority: input.priority,
    merchant_pattern: input.merchantPattern ?? null,
    payee_pattern: input.payeePattern ?? null,
    plaid_category: input.plaidCategory ?? null,
    account_id: input.accountId ?? null,
    amount_min: input.amountMin ?? null,
    amount_max: input.amountMax ?? null,
    category_id: input.categoryId ?? null,
    goal_id: input.goalId ?? null,
    goal_line_id: input.goalLineId ?? null,
    source: input.source ?? "manual",
    locked_at: input.lock ? new Date().toISOString() : null,
    active: (input.active ?? true) ? 1 : 0,
    created_at: new Date().toISOString(),
  };
  upsertRule(row);

  let applied = 0;
  if (retroactiveMonths > 0) {
    const today = new Date().toISOString().slice(0, 10);
    const start = `${addMonths(monthOf(today), -retroactiveMonths)}-01`;
    applied = categorizeRange({ start, end: today });
  }
  return { ruleId: row.rule_id, applied };
}

export function deleteRule(ruleId: string): void {
  repoDeleteRule(ruleId);
}

export interface InboxCard {
  transaction: {
    transactionId: string;
    date: string;
    merchant: string | null;
    amount: number;
    plaidPrimary: string | null;
  };
  suggestedCategoryId: string | null;
}

/** The uncategorized card stack, each with a history-based suggestion. */
export function getInbox(limit = 25): { count: number; cards: InboxCard[] } {
  const uncategorized = listUncategorized(limit);
  const today = new Date().toISOString().slice(0, 10);
  const history = flowsForRange({ start: `${addMonths(monthOf(today), -6)}-01`, end: today });

  return {
    count: uncategorizedCount(),
    cards: uncategorized.map((tx) => ({
      transaction: {
        transactionId: tx.transactionId,
        date: tx.date,
        merchant: tx.merchantName ?? tx.payee,
        // signed flow: positive = money in — the UI needs the direction to
        // offer income categories for deposits
        amount: signedFlow(tx),
        plaidPrimary: tx.plaidPrimary,
      },
      suggestedCategoryId: suggestCategory(tx, history),
    })),
  };
}

export function categorizeManually(transactionId: string, categoryId: string | null): boolean {
  const changed = setTransactionCategory(transactionId, categoryId, "manual");
  // a bill flagged from the inbox has no category yet — the first manual
  // categorization of its charge becomes the bill's category too
  if (changed && categoryId) adoptRecurringCategory(transactionId, categoryId);
  return changed;
}

// ---- the Transactions page: every row for a month, browsable & editable ----

export interface TransactionListItem {
  transactionId: string;
  date: string;
  merchant: string | null;
  /** Signed flow: positive = money in. */
  amount: number;
  pending: boolean;
  accountId: string;
  accountName: string;
  accountMask: string | null;
  personId: string | null;
  categoryId: string | null;
  categorizationSource: "plaid" | "rule" | "manual";
  plaidPrimary: string | null;
  isTransfer: boolean;
  /** Marked as a transfer but its counterpart hasn't been found yet. */
  transferPending: boolean;
  reimbursedBy: "work" | "buildings" | null;
  goalId: string | null;
}

export interface TransactionsListView {
  month: string;
  count: number;
  totalIn: number;
  totalOut: number;
  transactions: TransactionListItem[];
}

export interface TransactionsListOpts {
  /** Substring match against merchant/payee, case-insensitive. */
  search?: string;
  /** Category filter; "uncategorized" and "transfer" are virtual buckets. */
  categoryId?: string;
  limit?: number;
  offset?: number;
}

/** Every transaction in the viewed month (transfers and flagged rows
 *  included — this is the raw ledger, not the budget's filtered view). */
export function listTransactions(ctx: EngineContext, opts: TransactionsListOpts = {}): TransactionsListView {
  const accountsById = new Map(listAccounts().map((a) => [a.account_id, a]));
  const needle = opts.search?.trim().toLowerCase();

  let rows = flowsForRange(ctx.range).filter((t) => inLens(t.personId, ctx.lens));
  if (needle) {
    rows = rows.filter((t) =>
      (t.merchantName ?? t.payee ?? "").toLowerCase().includes(needle),
    );
  }
  if (opts.categoryId === "uncategorized") {
    rows = rows.filter((t) => !t.categoryId && !t.isTransfer && !t.reimbursedBy && !t.goalId);
  } else if (opts.categoryId === "transfer") {
    rows = rows.filter((t) => t.isTransfer);
  } else if (opts.categoryId) {
    rows = rows.filter((t) => t.categoryId === opts.categoryId);
  }

  let totalIn = 0;
  let totalOut = 0;
  for (const t of rows) {
    if (t.isTransfer) continue;
    const flow = signedFlow(t);
    if (flow > 0) totalIn += flow;
    else totalOut -= flow;
  }

  const sorted = rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const offset = opts.offset ?? 0;
  const page = sorted.slice(offset, offset + (opts.limit ?? 100));

  return {
    month: ctx.month,
    count: rows.length,
    totalIn: Math.round(totalIn * 100) / 100,
    totalOut: Math.round(totalOut * 100) / 100,
    transactions: page.map((t) => {
      const acc = accountsById.get(t.accountId);
      return {
        transactionId: t.transactionId,
        date: t.date,
        merchant: t.merchantName ?? t.payee,
        amount: signedFlow(t),
        pending: t.pending,
        accountId: t.accountId,
        accountName: acc?.name ?? acc?.official_name ?? t.accountId,
        accountMask: acc?.mask ?? null,
        personId: t.personId,
        categoryId: t.categoryId,
        categorizationSource: t.categorizationSource,
        plaidPrimary: t.plaidPrimary,
        isTransfer: t.isTransfer,
        transferPending: t.isTransfer && !t.transferGroupId,
        reimbursedBy: t.reimbursedBy,
        goalId: t.goalId ?? null,
      };
    }),
  };
}

/**
 * Transfer sweep: pair opposite-amount transactions across different own
 * accounts within an 8-day window (the $833 vacation transfer must not read
 * as spending). Cross-institution moves and credit-card payments can take
 * most of a week to settle on both sides, hence the wide window. Pairs
 * greedily by date proximity; already-marked rows skip.
 */
const TRANSFER_WINDOW_DAYS = 8;

export function detectTransfers(range: { start: string; end: string }): number {
  const txs = flowsForRange(range).filter((t) => !t.isTransfer && !t.pending);
  const byAmount = new Map<string, FlowTx[]>();
  for (const tx of txs) {
    const key = Math.abs(tx.amount).toFixed(2);
    const list = byAmount.get(key) ?? [];
    list.push(tx);
    byAmount.set(key, list);
  }

  let pairs = 0;
  const used = new Set<string>();
  for (const list of byAmount.values()) {
    if (list.length < 2) continue;
    const outs = list.filter((t) => t.amount > 0);
    const ins = list.filter((t) => t.amount < 0);
    for (const out of outs) {
      if (used.has(out.transactionId)) continue;
      let best: FlowTx | null = null;
      let bestGap = Number.POSITIVE_INFINITY;
      for (const cand of ins) {
        if (used.has(cand.transactionId) || cand.accountId === out.accountId) continue;
        const gap = Math.abs(
          (new Date(cand.date).getTime() - new Date(out.date).getTime()) / 86_400_000,
        );
        if (gap <= TRANSFER_WINDOW_DAYS && gap < bestGap) {
          best = cand;
          bestGap = gap;
        }
      }
      if (best) {
        markTransferPair(out.transactionId, best.transactionId);
        used.add(out.transactionId);
        used.add(best.transactionId);
        pairs++;
      }
    }
  }
  return pairs;
}

// ---- user-marked transfers: mark one leg now, validate when the other lands ----

/**
 * Pair user-marked pending legs with their counterparts: opposite sign, same
 * absolute amount, different account, settled, within the 8-day window. A
 * counterpart the user also marked wins over an unmarked row; ties break by
 * date proximity. Legs older than the window with no match raise an alert —
 * the mark stays (it still shouldn't count as spending) but the user should
 * know validation failed.
 */
export function matchPendingTransfers(today = new Date().toISOString().slice(0, 10)): {
  matched: number;
  stale: number;
} {
  let matched = 0;
  let stale = 0;
  const used = new Set<string>();
  for (const leg of listPendingTransferLegs()) {
    if (used.has(leg.transactionId)) continue; // paired as an earlier leg's counterpart
    const window = {
      start: addDays(leg.date, -TRANSFER_WINDOW_DAYS),
      end: addDays(leg.date, TRANSFER_WINDOW_DAYS),
    };
    const candidates = flowsForRange(window).filter(
      (c) =>
        c.transactionId !== leg.transactionId &&
        !used.has(c.transactionId) &&
        c.accountId !== leg.accountId &&
        !c.pending &&
        c.amount !== 0 &&
        Math.sign(c.amount) === -Math.sign(leg.amount) &&
        Math.abs(c.amount).toFixed(2) === Math.abs(leg.amount).toFixed(2) &&
        (!c.isTransfer || !c.transferGroupId),
    );
    const best = candidates.sort((a, b) => {
      const aMarked = a.isTransfer ? 0 : 1; // fellow marked legs first
      const bMarked = b.isTransfer ? 0 : 1;
      if (aMarked !== bMarked) return aMarked - bMarked;
      return Math.abs(dayDiff(leg.date, a.date)) - Math.abs(dayDiff(leg.date, b.date));
    })[0];
    if (best) {
      markTransferPair(leg.transactionId, best.transactionId);
      used.add(leg.transactionId);
      used.add(best.transactionId);
      matched++;
    } else if (dayDiff(leg.date, today) > TRANSFER_WINDOW_DAYS) {
      stale++;
      createAlert(
        {
          alert_type: "transfer_unmatched",
          severity: "warning",
          title: `Transfer marked on ${leg.date} still has no matching leg`,
          body: `"${leg.merchantName ?? leg.payee ?? "unknown"}" ($${Math.abs(leg.amount).toFixed(2)}) was marked as a transfer, but no opposite transaction appeared within ${TRANSFER_WINDOW_DAYS} days. If it isn't really a transfer, unmark it from the Transactions page so it counts in the budget again.`,
          payload: { transactionId: leg.transactionId },
        },
        new Date().toISOString(),
      );
    }
  }
  return { matched, stale };
}

/** Inbox "transfer to another account": mark the leg, then try to validate
 *  immediately in case the counterpart already synced. */
export function markTransferPending(transactionId: string): { marked: boolean; matched: boolean } {
  if (!setPendingTransfer(transactionId)) return { marked: false, matched: false };
  matchPendingTransfers();
  const after = getFlowTx(transactionId);
  return { marked: true, matched: !!after?.transferGroupId };
}

/** Undo a transfer mark (both legs when already validated). */
export function unmarkTransfer(transactionId: string): number {
  return clearTransferMark(transactionId);
}
