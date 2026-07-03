/**
 * analytics/categorize.ts — the category rules engine. Pure.
 * Priority convention: LOWER number = higher priority (1 wins over 10).
 * The trust invariant lives in applyRules: rows categorized manually are
 * never patched.
 */
import type { FlowTx } from "./types.js";

export interface CategoryRule {
  ruleId: string;
  priority: number;
  merchantPattern: string | null;
  payeePattern: string | null;
  plaidCategory: string | null;
  accountId: string | null;
  amountMin: number | null;
  amountMax: number | null;
  /** Budget target. A rule targets a category OR a goal — never neither. */
  categoryId: string | null;
  /** Goal target: tag matching spend to this goal's envelope… */
  goalId?: string | null;
  /** …and optionally to one of its line items (trip → hotel vs food). */
  goalLineId?: string | null;
  /** Locked mappings are confirmed-forever: deletable, never editable. */
  locked?: boolean;
  source?: "manual" | "ai";
  active: boolean;
}

export interface CategoryPatch {
  transactionId: string;
  categoryId: string;
}

export interface GoalPatch {
  transactionId: string;
  goalId: string;
  goalLineId: string | null;
}

function textMatches(pattern: string, value: string | null): boolean {
  return value !== null && value.toLowerCase().includes(pattern.toLowerCase());
}

/** Every populated condition must hold; empty conditions are ignored. */
export function ruleMatches(tx: FlowTx, rule: CategoryRule): boolean {
  if (!rule.active) return false;
  if (rule.merchantPattern !== null && !textMatches(rule.merchantPattern, tx.merchantName)) {
    return false;
  }
  if (rule.payeePattern !== null && !textMatches(rule.payeePattern, tx.payee)) return false;
  if (
    rule.plaidCategory !== null &&
    rule.plaidCategory !== tx.plaidPrimary &&
    rule.plaidCategory !== tx.plaidDetailed
  ) {
    return false;
  }
  if (rule.accountId !== null && rule.accountId !== tx.accountId) return false;
  if (rule.amountMin !== null && tx.amount < rule.amountMin) return false;
  if (rule.amountMax !== null && tx.amount > rule.amountMax) return false;
  // A rule with only a priority and target would match everything by
  // accident — require at least one condition.
  return (
    rule.merchantPattern !== null ||
    rule.payeePattern !== null ||
    rule.plaidCategory !== null ||
    rule.accountId !== null ||
    rule.amountMin !== null ||
    rule.amountMax !== null
  );
}

/** Highest-priority (lowest number) matching rule, ties broken by ruleId. */
export function resolveRule(tx: FlowTx, rules: CategoryRule[]): CategoryRule | null {
  let best: CategoryRule | null = null;
  for (const rule of rules) {
    if (!ruleMatches(tx, rule)) continue;
    if (!best || rule.priority < best.priority || (rule.priority === best.priority && rule.ruleId < best.ruleId)) {
      best = rule;
    }
  }
  return best;
}

export function resolveCategory(tx: FlowTx, rules: CategoryRule[]): string | null {
  return resolveRule(tx, rules.filter((r) => r.categoryId !== null))?.categoryId ?? null;
}

/**
 * Patches to (re)apply rules across `txs`. Never patches manual rows; only
 * emits a patch when the resolved category differs from the current one.
 */
export function applyRules(txs: FlowTx[], rules: CategoryRule[]): CategoryPatch[] {
  const categoryRules = rules.filter((r) => r.categoryId !== null);
  const patches: CategoryPatch[] = [];
  for (const tx of txs) {
    if (tx.categorizationSource === "manual") continue;
    if (tx.goalId) continue; // goal-tagged rows left the budget entirely
    const resolved = resolveRule(tx, categoryRules)?.categoryId ?? null;
    if (resolved !== null && resolved !== tx.categoryId) {
      patches.push({ transactionId: tx.transactionId, categoryId: resolved });
    }
  }
  return patches;
}

/**
 * Goal-rule pass: tag matching transactions to a goal (and optionally a line
 * item). Conservative on purpose — only touches rows nobody has classified
 * yet (no category, no goal, not manual), so it can never fight a human.
 */
export function applyGoalRules(txs: FlowTx[], rules: CategoryRule[]): GoalPatch[] {
  const goalRules = rules.filter((r) => r.goalId != null && r.categoryId === null);
  if (goalRules.length === 0) return [];
  const patches: GoalPatch[] = [];
  for (const tx of txs) {
    if (tx.categorizationSource === "manual" || tx.categoryId !== null || tx.goalId) continue;
    const rule = resolveRule(tx, goalRules);
    if (rule?.goalId) {
      patches.push({ transactionId: tx.transactionId, goalId: rule.goalId, goalLineId: rule.goalLineId ?? null });
    }
  }
  return patches;
}

/**
 * Best-guess category for the uncategorized inbox: the dominant category
 * among past transactions with the same merchant (falling back to payee).
 */
export function suggestCategory(tx: FlowTx, history: FlowTx[]): string | null {
  const name = (tx.merchantName ?? tx.payee)?.toLowerCase();
  if (!name) return null;
  const counts = new Map<string, number>();
  for (const h of history) {
    if (h.categoryId === null) continue;
    const hName = (h.merchantName ?? h.payee)?.toLowerCase();
    if (hName !== name) continue;
    counts.set(h.categoryId, (counts.get(h.categoryId) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [categoryId, count] of counts) {
    if (count > bestCount) {
      best = categoryId;
      bestCount = count;
    }
  }
  return best;
}
