/**
 * db/repositories/budgeting.ts — data access for categories, rules, budgets,
 * and the categorized-transaction read path (FlowTx rows for analytics).
 */
import { randomUUID } from "node:crypto";
import { getDb } from "../db.js";
import type { CategoryKind, CategoryNode, DateRange, FlowTx } from "../../analytics/types.js";
import type { CategoryRule } from "../../analytics/categorize.js";

export interface CategoryRow {
  category_id: string;
  parent_id: string | null;
  name: string;
  kind: CategoryKind;
  sort_order: number;
  archived: number;
}

export interface CategoryRuleRow {
  rule_id: string;
  priority: number;
  merchant_pattern: string | null;
  payee_pattern: string | null;
  plaid_category: string | null;
  account_id: string | null;
  amount_min: number | null;
  amount_max: number | null;
  category_id: string | null;
  goal_id: string | null;
  goal_line_id: string | null;
  source: "manual" | "ai";
  locked_at: string | null;
  active: number;
  created_at: string;
}

export interface BudgetVersionRow {
  version_id: string;
  name: string;
  effective_from: string;
  created_at: string;
  notes: string | null;
}

export interface BudgetLineRow {
  version_id: string;
  category_id: string;
  person_id: string | null;
  monthly_amount: number;
}

export function toCategoryNode(row: CategoryRow): CategoryNode {
  return {
    categoryId: row.category_id,
    parentId: row.parent_id,
    name: row.name,
    kind: row.kind,
    sortOrder: row.sort_order,
  };
}

export function toCategoryRule(row: CategoryRuleRow): CategoryRule {
  return {
    ruleId: row.rule_id,
    priority: row.priority,
    merchantPattern: row.merchant_pattern,
    payeePattern: row.payee_pattern,
    plaidCategory: row.plaid_category,
    accountId: row.account_id,
    amountMin: row.amount_min,
    amountMax: row.amount_max,
    categoryId: row.category_id,
    goalId: row.goal_id,
    goalLineId: row.goal_line_id,
    locked: row.locked_at !== null,
    source: row.source,
    active: row.active === 1,
  };
}

export function getRule(ruleId: string): CategoryRuleRow | undefined {
  return getDb().prepare(`SELECT * FROM category_rules WHERE rule_id = ?`).get(ruleId) as
    | CategoryRuleRow
    | undefined;
}

export function listCategories(includeArchived = false): CategoryRow[] {
  const where = includeArchived ? "" : "WHERE archived = 0";
  return getDb()
    .prepare(`SELECT * FROM categories ${where} ORDER BY sort_order, name`)
    .all() as CategoryRow[];
}

export function upsertCategory(row: CategoryRow): void {
  getDb()
    .prepare(
      `INSERT INTO categories (category_id, parent_id, name, kind, sort_order, archived)
       VALUES (@category_id, @parent_id, @name, @kind, @sort_order, @archived)
       ON CONFLICT(category_id) DO UPDATE SET
         parent_id = excluded.parent_id,
         name = excluded.name,
         kind = excluded.kind,
         sort_order = excluded.sort_order,
         archived = excluded.archived`,
    )
    .run(row);
}

export function listRules(activeOnly = true): CategoryRuleRow[] {
  const where = activeOnly ? "WHERE active = 1" : "";
  return getDb()
    .prepare(`SELECT * FROM category_rules ${where} ORDER BY priority, rule_id`)
    .all() as CategoryRuleRow[];
}

/**
 * Insert/update a rule. Locked rows are immutable: the update arm refuses to
 * touch them (WHERE locked_at IS NULL), and we throw so callers surface it —
 * a locked mapping is a promise to the user, not a default.
 */
export function upsertRule(row: CategoryRuleRow): void {
  const existing = getRule(row.rule_id);
  if (existing?.locked_at) {
    throw Object.assign(new Error("mapping is locked — delete it to change it"), { status: 409 });
  }
  getDb()
    .prepare(
      `INSERT INTO category_rules (rule_id, priority, merchant_pattern, payee_pattern, plaid_category, account_id, amount_min, amount_max, category_id, goal_id, goal_line_id, source, locked_at, active, created_at)
       VALUES (@rule_id, @priority, @merchant_pattern, @payee_pattern, @plaid_category, @account_id, @amount_min, @amount_max, @category_id, @goal_id, @goal_line_id, @source, @locked_at, @active, @created_at)
       ON CONFLICT(rule_id) DO UPDATE SET
         priority = excluded.priority,
         merchant_pattern = excluded.merchant_pattern,
         payee_pattern = excluded.payee_pattern,
         plaid_category = excluded.plaid_category,
         account_id = excluded.account_id,
         amount_min = excluded.amount_min,
         amount_max = excluded.amount_max,
         category_id = excluded.category_id,
         goal_id = excluded.goal_id,
         goal_line_id = excluded.goal_line_id,
         source = excluded.source,
         locked_at = excluded.locked_at,
         active = excluded.active
       WHERE category_rules.locked_at IS NULL`,
    )
    .run(row);
}

export function deleteRule(ruleId: string): void {
  getDb().prepare(`DELETE FROM category_rules WHERE rule_id = ?`).run(ruleId);
}

/**
 * Explicitly retarget a rule at a new budget category — allowed even on
 * locked rules. The lock protects a mapping from being *silently* rewritten
 * by upserts or the AI; a user deliberately picking a new category for the
 * merchant (Bills → edit category) is the mapping's owner changing their
 * mind, so the lock stays but the target moves.
 */
export function retargetRule(ruleId: string, categoryId: string): boolean {
  const result = getDb()
    .prepare(
      `UPDATE category_rules SET category_id = ?, goal_id = NULL, goal_line_id = NULL WHERE rule_id = ?`,
    )
    .run(categoryId, ruleId);
  return result.changes > 0;
}

/** The budget version governing a month: greatest effective_from <= month-01. */
export function activeBudgetForMonth(
  month: string,
): { version: BudgetVersionRow; lines: BudgetLineRow[] } | null {
  const version = getDb()
    .prepare(
      `SELECT * FROM budget_versions WHERE effective_from <= ? ORDER BY effective_from DESC, created_at DESC LIMIT 1`,
    )
    .get(`${month}-01`) as BudgetVersionRow | undefined;
  if (!version) return null;
  const lines = getDb()
    .prepare(`SELECT * FROM budget_lines WHERE version_id = ?`)
    .all(version.version_id) as BudgetLineRow[];
  return { version, lines };
}

export function listBudgetVersions(): BudgetVersionRow[] {
  return getDb()
    .prepare(`SELECT * FROM budget_versions ORDER BY effective_from DESC`)
    .all() as BudgetVersionRow[];
}

export function createBudgetVersion(
  name: string,
  effectiveFrom: string,
  notes: string | null,
  lines: Omit<BudgetLineRow, "version_id">[],
  createdAt: string,
): BudgetVersionRow {
  const db = getDb();
  const version: BudgetVersionRow = {
    version_id: randomUUID(),
    name,
    effective_from: effectiveFrom,
    created_at: createdAt,
    notes,
  };
  const insertVersion = db.prepare(
    `INSERT INTO budget_versions (version_id, name, effective_from, created_at, notes)
     VALUES (@version_id, @name, @effective_from, @created_at, @notes)`,
  );
  const insertLine = db.prepare(
    `INSERT INTO budget_lines (version_id, category_id, person_id, monthly_amount)
     VALUES (?, ?, ?, ?)`,
  );
  db.transaction(() => {
    insertVersion.run(version);
    for (const line of lines) {
      insertLine.run(version.version_id, line.category_id, line.person_id, line.monthly_amount);
    }
  })();
  return version;
}

/**
 * Write one transaction's category. Rule/plaid writes never overwrite a
 * manual categorization; manual always wins and always writes.
 */
export function setTransactionCategory(
  transactionId: string,
  categoryId: string | null,
  source: "plaid" | "rule" | "manual",
): boolean {
  const guard = source === "manual" ? "" : `AND categorization_source != 'manual'`;
  const result = getDb()
    .prepare(
      `UPDATE transactions SET category_id = ?, categorization_source = ? WHERE transaction_id = ? ${guard}`,
    )
    .run(categoryId, source, transactionId);
  return result.changes > 0;
}

export function bulkApplyCategoryPatches(
  patches: { transactionId: string; categoryId: string }[],
  source: "plaid" | "rule",
): number {
  const db = getDb();
  const stmt = db.prepare(
    `UPDATE transactions SET category_id = ?, categorization_source = ?
     WHERE transaction_id = ? AND categorization_source != 'manual'`,
  );
  let applied = 0;
  db.transaction(() => {
    for (const p of patches) {
      applied += stmt.run(p.categoryId, source, p.transactionId).changes;
    }
  })();
  return applied;
}

const FLOW_SELECT = `
  SELECT t.transaction_id, t.account_id, a.person_id, t.amount, t.iso_currency_code,
         t.date, t.merchant_name, t.payee, t.category_id, t.categorization_source,
         t.personal_finance_category_primary, t.personal_finance_category_detailed,
         t.is_transfer, t.transfer_group_id, t.reimbursed_by, t.goal_id, t.goal_line_id, t.pending
  FROM transactions t
  JOIN accounts a ON a.account_id = t.account_id
  WHERE t.removed = 0 AND a.tracked = 1 AND a.is_closed = 0`;

interface FlowRow {
  transaction_id: string;
  account_id: string;
  person_id: string | null;
  amount: number;
  iso_currency_code: string | null;
  date: string;
  merchant_name: string | null;
  payee: string | null;
  category_id: string | null;
  categorization_source: "plaid" | "rule" | "manual";
  personal_finance_category_primary: string | null;
  personal_finance_category_detailed: string | null;
  is_transfer: number;
  transfer_group_id: string | null;
  reimbursed_by: "work" | "buildings" | null;
  goal_id: string | null;
  goal_line_id: string | null;
  pending: number;
}

function toFlowTx(row: FlowRow): FlowTx {
  return {
    transactionId: row.transaction_id,
    accountId: row.account_id,
    personId: row.person_id,
    amount: row.amount,
    currency: row.iso_currency_code,
    date: row.date,
    merchantName: row.merchant_name,
    payee: row.payee,
    categoryId: row.category_id,
    categorizationSource: row.categorization_source,
    plaidPrimary: row.personal_finance_category_primary,
    plaidDetailed: row.personal_finance_category_detailed,
    isTransfer: row.is_transfer === 1,
    transferGroupId: row.transfer_group_id,
    reimbursedBy: row.reimbursed_by,
    goalId: row.goal_id,
    goalLineId: row.goal_line_id,
    pending: row.pending === 1,
  };
}

/** All tracked-account flows in a date range, as analytics FlowTx rows. */
export function flowsForRange(range: DateRange, categoryId?: string): FlowTx[] {
  const extra = categoryId ? "AND t.category_id = @categoryId" : "";
  const rows = getDb()
    .prepare(`${FLOW_SELECT} AND t.date >= @start AND t.date <= @end ${extra} ORDER BY t.date`)
    .all({ start: range.start, end: range.end, categoryId }) as FlowRow[];
  return rows.map(toFlowTx);
}

export function getFlowTx(transactionId: string): FlowTx | undefined {
  const row = getDb()
    .prepare(`${FLOW_SELECT} AND t.transaction_id = ?`)
    .get(transactionId) as FlowRow | undefined;
  return row ? toFlowTx(row) : undefined;
}

export function listUncategorized(limit: number): FlowTx[] {
  const rows = getDb()
    .prepare(
      `${FLOW_SELECT} AND t.category_id IS NULL AND t.is_transfer = 0
         AND t.reimbursed_by IS NULL AND t.goal_id IS NULL ORDER BY t.date DESC LIMIT ?`,
    )
    .all(limit) as FlowRow[];
  return rows.map(toFlowTx);
}

export function uncategorizedCount(): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM transactions t
       JOIN accounts a ON a.account_id = t.account_id
       WHERE t.removed = 0 AND a.tracked = 1 AND a.is_closed = 0
         AND t.category_id IS NULL AND t.is_transfer = 0
         AND t.reimbursed_by IS NULL AND t.goal_id IS NULL`,
    )
    .get() as { n: number };
  return row.n;
}

export interface TransactionFlags {
  reimbursedBy?: "work" | "buildings" | null;
  goalId?: string | null;
  goalLineId?: string | null;
}

/** Set/clear the budget-exclusion flags on one transaction. */
export function setTransactionFlags(transactionId: string, flags: TransactionFlags): boolean {
  const sets: string[] = [];
  const params: Record<string, unknown> = { transaction_id: transactionId };
  if (flags.reimbursedBy !== undefined) {
    sets.push("reimbursed_by = @reimbursed_by");
    params.reimbursed_by = flags.reimbursedBy;
  }
  if (flags.goalId !== undefined) {
    sets.push("goal_id = @goal_id");
    params.goal_id = flags.goalId;
    // clearing the goal always clears the line item; setting one without an
    // explicit line resets it too (the line belongs to the previous goal)
    if (flags.goalLineId === undefined) {
      sets.push("goal_line_id = NULL");
    }
  }
  if (flags.goalLineId !== undefined) {
    sets.push("goal_line_id = @goal_line_id");
    params.goal_line_id = flags.goalLineId;
  }
  if (sets.length === 0) return false;
  const info = getDb()
    .prepare(`UPDATE transactions SET ${sets.join(", ")} WHERE transaction_id = @transaction_id`)
    .run(params);
  return info.changes > 0;
}

/**
 * Bulk goal-tag from goal rules. Same trust rules as the pure engine
 * (applyGoalRules): only rows nobody classified yet are touched.
 */
export function bulkApplyGoalPatches(
  patches: { transactionId: string; goalId: string; goalLineId: string | null }[],
): number {
  const db = getDb();
  const stmt = db.prepare(
    `UPDATE transactions SET goal_id = ?, goal_line_id = ?
     WHERE transaction_id = ? AND goal_id IS NULL AND category_id IS NULL
       AND categorization_source != 'manual'`,
  );
  let applied = 0;
  db.transaction(() => {
    for (const p of patches) {
      applied += stmt.run(p.goalId, p.goalLineId, p.transactionId).changes;
    }
  })();
  return applied;
}

/** Net spend per goal line item (goal subcategory), for one goal. */
export function goalLineTaggedSpend(goalId: string): Map<string, number> {
  const rows = getDb()
    .prepare(
      `SELECT t.goal_line_id AS line_id, SUM(t.amount) AS total
       FROM transactions t
       WHERE t.removed = 0 AND t.goal_id = ? AND t.goal_line_id IS NOT NULL
       GROUP BY t.goal_line_id`,
    )
    .all(goalId) as { line_id: string; total: number }[];
  return new Map(rows.map((r) => [r.line_id, Math.round(r.total * 100) / 100]));
}

/** Net spend (money out − refunds) per goal, all-time or within a range. */
export function goalTaggedSpend(range?: { start: string; end: string }): Map<string, number> {
  const where = range ? "AND t.date >= ? AND t.date <= ?" : "";
  const rows = getDb()
    .prepare(
      `SELECT t.goal_id AS goal_id, SUM(t.amount) AS total
       FROM transactions t
       WHERE t.removed = 0 AND t.goal_id IS NOT NULL ${where}
       GROUP BY t.goal_id`,
    )
    .all(...(range ? [range.start, range.end] : [])) as { goal_id: string; total: number }[];
  return new Map(rows.map((r) => [r.goal_id, Math.round(r.total * 100) / 100]));
}

export interface TransferLegRow {
  transfer_group_id: string;
  transaction_id: string;
  account_id: string;
  amount: number;
  date: string;
}

/** Both legs of every marked transfer pair in a date range. */
export function transferLegsForRange(range: DateRange): TransferLegRow[] {
  return getDb()
    .prepare(
      `SELECT t.transfer_group_id, t.transaction_id, t.account_id, t.amount, t.date
       FROM transactions t
       WHERE t.removed = 0 AND t.is_transfer = 1 AND t.transfer_group_id IS NOT NULL
         AND t.date >= ? AND t.date <= ?
       ORDER BY t.date`,
    )
    .all(range.start, range.end) as TransferLegRow[];
}

/** Mark a detected transfer pair. */
export function markTransferPair(txIdA: string, txIdB: string): void {
  const groupId = randomUUID();
  const stmt = getDb().prepare(
    `UPDATE transactions SET is_transfer = 1, transfer_group_id = ? WHERE transaction_id = ?`,
  );
  const db = getDb();
  db.transaction(() => {
    stmt.run(groupId, txIdA);
    stmt.run(groupId, txIdB);
  })();
}

/**
 * User-marked single transfer leg: excluded from budget flows right away, but
 * pending (no group) until the sweep finds its counterpart. Clears any
 * category — transfers carry none — and stamps the source manual so rules
 * never re-categorize it.
 */
export function setPendingTransfer(transactionId: string): boolean {
  return (
    getDb()
      .prepare(
        `UPDATE transactions
         SET is_transfer = 1, transfer_group_id = NULL, category_id = NULL, categorization_source = 'manual'
         WHERE transaction_id = ?`,
      )
      .run(transactionId).changes > 0
  );
}

/** Undo a transfer mark. A validated pair unmarks BOTH legs — a half-pair
 *  would silently distort both accounts' flows. */
export function clearTransferMark(transactionId: string): number {
  const db = getDb();
  const row = db
    .prepare(`SELECT transfer_group_id FROM transactions WHERE transaction_id = ?`)
    .get(transactionId) as { transfer_group_id: string | null } | undefined;
  if (!row) return 0;
  if (row.transfer_group_id) {
    return db
      .prepare(
        `UPDATE transactions SET is_transfer = 0, transfer_group_id = NULL WHERE transfer_group_id = ?`,
      )
      .run(row.transfer_group_id).changes;
  }
  return db
    .prepare(
      `UPDATE transactions SET is_transfer = 0, transfer_group_id = NULL WHERE transaction_id = ?`,
    )
    .run(transactionId).changes;
}

/** User-marked transfer legs still waiting for a counterpart. */
export function listPendingTransferLegs(): FlowTx[] {
  const rows = getDb()
    .prepare(`${FLOW_SELECT} AND t.is_transfer = 1 AND t.transfer_group_id IS NULL ORDER BY t.date`)
    .all() as FlowRow[];
  return rows.map(toFlowTx);
}
