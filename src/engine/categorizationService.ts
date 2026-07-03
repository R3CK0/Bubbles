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
  addMonths,
  monthOf,
  type CategoryRule,
  type FlowTx,
} from "../analytics/index.js";
import {
  bulkApplyCategoryPatches,
  bulkApplyGoalPatches,
  flowsForRange,
  listRules,
  listUncategorized,
  markTransferPair,
  setTransactionCategory,
  toCategoryRule,
  upsertRule,
  uncategorizedCount,
  deleteRule as repoDeleteRule,
  type CategoryRuleRow,
} from "../db/repositories/budgeting.js";

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
        amount: Math.abs(signedFlow(tx)),
        plaidPrimary: tx.plaidPrimary,
      },
      suggestedCategoryId: suggestCategory(tx, history),
    })),
  };
}

export function categorizeManually(transactionId: string, categoryId: string | null): boolean {
  return setTransactionCategory(transactionId, categoryId, "manual");
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
