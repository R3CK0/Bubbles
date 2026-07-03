/**
 * db/repositories/planning.ts — data access for goals, plans, scenarios.
 */
import { randomUUID } from "node:crypto";
import { getDb } from "../db.js";
import type { GoalInput } from "../../analytics/goals.js";

export interface GoalRow {
  goal_id: string;
  goal_type: "house" | "kid" | "trip" | "purchase" | "savings" | "event" | "emergency_fund" | "debt_payoff";
  name: string;
  person_id: string | null;
  target_amount: number;
  target_date: string | null;
  priority: number;
  linked_account_id: string | null;
  linked_debt_id: string | null;
  funded_amount: number;
  status: "active" | "achieved" | "abandoned" | "paused";
  params_json: string | null;
  created_at: string;
  notes: string | null;
}

export function toGoalInput(row: GoalRow): GoalInput {
  return {
    goalId: row.goal_id,
    goalType: row.goal_type,
    name: row.name,
    personId: row.person_id,
    priority: row.priority,
    targetAmount: row.target_amount,
    fundedAmount: row.funded_amount,
    targetDate: row.target_date,
  };
}

export function listGoals(status: GoalRow["status"] | "all" = "active"): GoalRow[] {
  if (status === "all") {
    return getDb().prepare(`SELECT * FROM goals ORDER BY priority, target_date`).all() as GoalRow[];
  }
  return getDb().prepare(`SELECT * FROM goals WHERE status = ? ORDER BY priority, target_date`).all(status) as GoalRow[];
}

export function getGoal(goalId: string): GoalRow | undefined {
  return getDb().prepare(`SELECT * FROM goals WHERE goal_id = ?`).get(goalId) as GoalRow | undefined;
}

export interface GoalCreate {
  goalType: GoalRow["goal_type"];
  name: string;
  personId?: string | null;
  targetAmount: number;
  targetDate?: string | null;
  priority?: number;
  linkedAccountId?: string | null;
  linkedDebtId?: string | null;
  fundedAmount?: number;
  params?: unknown;
  notes?: string | null;
}

export function createGoal(input: GoalCreate, now: string): GoalRow {
  const row: GoalRow = {
    goal_id: randomUUID(),
    goal_type: input.goalType,
    name: input.name,
    person_id: input.personId ?? null,
    target_amount: input.targetAmount,
    target_date: input.targetDate ?? null,
    priority: input.priority ?? 3,
    linked_account_id: input.linkedAccountId ?? null,
    linked_debt_id: input.linkedDebtId ?? null,
    funded_amount: input.fundedAmount ?? 0,
    status: "active",
    params_json: input.params === undefined ? null : JSON.stringify(input.params),
    created_at: now,
    notes: input.notes ?? null,
  };
  getDb()
    .prepare(
      `INSERT INTO goals (goal_id, goal_type, name, person_id, target_amount, target_date, priority, linked_account_id, linked_debt_id, funded_amount, status, params_json, created_at, notes)
       VALUES (@goal_id, @goal_type, @name, @person_id, @target_amount, @target_date, @priority, @linked_account_id, @linked_debt_id, @funded_amount, @status, @params_json, @created_at, @notes)`,
    )
    .run(row);
  return row;
}

const GOAL_PATCHABLE = new Set([
  "name",
  "person_id",
  "target_amount",
  "target_date",
  "priority",
  "linked_account_id",
  "linked_debt_id",
  "funded_amount",
  "status",
  "params_json",
  "notes",
]);

export function updateGoal(goalId: string, patch: Partial<GoalRow>): GoalRow | undefined {
  const sets: string[] = [];
  const params: Record<string, unknown> = { goal_id: goalId };
  for (const [key, value] of Object.entries(patch)) {
    if (!GOAL_PATCHABLE.has(key) || value === undefined) continue;
    sets.push(`${key} = @${key}`);
    params[key] = value;
  }
  if (sets.length > 0) {
    getDb().prepare(`UPDATE goals SET ${sets.join(", ")} WHERE goal_id = @goal_id`).run(params);
  }
  return getGoal(goalId);
}

/** Refresh funded_amount from linked account balances (nightly). */
export function refreshFundedFromLinkedAccounts(): number {
  return getDb()
    .prepare(
      `UPDATE goals SET funded_amount = (
         SELECT COALESCE(a.current_balance, 0) FROM accounts a WHERE a.account_id = goals.linked_account_id
       )
       WHERE linked_account_id IS NOT NULL AND status = 'active'
         AND EXISTS (SELECT 1 FROM accounts a WHERE a.account_id = goals.linked_account_id)`,
    )
    .run().changes;
}

// ---- goal line items ----

export interface GoalLineItemRow {
  line_id: string;
  goal_id: string;
  name: string;
  amount: number;
  due_date: string | null;
  status: "planned" | "deposit_paid" | "paid" | "cancelled";
  transaction_id: string | null;
}

export function listLineItems(goalId: string): GoalLineItemRow[] {
  return getDb().prepare(`SELECT * FROM goal_line_items WHERE goal_id = ? ORDER BY due_date, name`).all(goalId) as GoalLineItemRow[];
}

export function upsertLineItem(row: GoalLineItemRow): void {
  getDb()
    .prepare(
      `INSERT INTO goal_line_items (line_id, goal_id, name, amount, due_date, status, transaction_id)
       VALUES (@line_id, @goal_id, @name, @amount, @due_date, @status, @transaction_id)
       ON CONFLICT(line_id) DO UPDATE SET
         name = excluded.name, amount = excluded.amount, due_date = excluded.due_date,
         status = excluded.status, transaction_id = excluded.transaction_id`,
    )
    .run(row);
}

export function deleteLineItem(lineId: string): void {
  getDb().prepare(`DELETE FROM goal_line_items WHERE line_id = ?`).run(lineId);
}

// ---- plans ----

export interface PlanRow {
  plan_id: string;
  name: string;
  created_at: string;
  approved_at: string | null;
  status: "draft" | "active" | "superseded" | "completed";
  solver_inputs_json: string | null;
  notes: string | null;
}

export interface PlanLineRow {
  plan_id: string;
  month: string;
  person_id: string | null;
  target_type: "goal" | "debt" | "fhsa" | "rrsp" | "tfsa" | "buffer";
  target_id: string | null;
  amount: number;
}

export function createDraftPlan(
  name: string,
  solverInputs: unknown,
  lines: Omit<PlanLineRow, "plan_id">[],
  now: string,
): PlanRow {
  const db = getDb();
  const plan: PlanRow = {
    plan_id: randomUUID(),
    name,
    created_at: now,
    approved_at: null,
    status: "draft",
    solver_inputs_json: JSON.stringify(solverInputs),
    notes: null,
  };
  const insertPlan = db.prepare(
    `INSERT INTO plans (plan_id, name, created_at, approved_at, status, solver_inputs_json, notes)
     VALUES (@plan_id, @name, @created_at, @approved_at, @status, @solver_inputs_json, @notes)`,
  );
  // plan_lines PK includes nullable columns; aggregate duplicates defensively.
  const merged = new Map<string, Omit<PlanLineRow, "plan_id">>();
  for (const l of lines) {
    const key = `${l.month}|${l.person_id ?? ""}|${l.target_type}|${l.target_id ?? ""}`;
    const prev = merged.get(key);
    merged.set(key, prev ? { ...l, amount: prev.amount + l.amount } : l);
  }
  const insertLine = db.prepare(
    `INSERT INTO plan_lines (plan_id, month, person_id, target_type, target_id, amount) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    insertPlan.run(plan);
    for (const l of merged.values()) {
      insertLine.run(plan.plan_id, l.month, l.person_id, l.target_type, l.target_id, Math.round(l.amount * 100) / 100);
    }
  })();
  return plan;
}

/** Approve a draft: current active plan becomes superseded, atomically. */
export function approvePlan(planId: string, now: string): PlanRow | undefined {
  const db = getDb();
  db.transaction(() => {
    db.prepare(`UPDATE plans SET status = 'superseded' WHERE status = 'active'`).run();
    db.prepare(`UPDATE plans SET status = 'active', approved_at = ? WHERE plan_id = ? AND status = 'draft'`).run(now, planId);
  })();
  return getDb().prepare(`SELECT * FROM plans WHERE plan_id = ?`).get(planId) as PlanRow | undefined;
}

export function activePlan(): { plan: PlanRow; lines: PlanLineRow[] } | null {
  const plan = getDb().prepare(`SELECT * FROM plans WHERE status = 'active' LIMIT 1`).get() as PlanRow | undefined;
  if (!plan) return null;
  const lines = getDb().prepare(`SELECT * FROM plan_lines WHERE plan_id = ? ORDER BY month`).all(plan.plan_id) as PlanLineRow[];
  return { plan, lines };
}

// ---- scenarios ----

export interface ScenarioRow {
  scenario_id: string;
  name: string;
  params_json: string;
  created_at: string;
  notes: string | null;
}

export function listScenarios(): ScenarioRow[] {
  return getDb().prepare(`SELECT * FROM scenarios ORDER BY created_at DESC`).all() as ScenarioRow[];
}

export function getScenario(scenarioId: string): ScenarioRow | undefined {
  return getDb().prepare(`SELECT * FROM scenarios WHERE scenario_id = ?`).get(scenarioId) as ScenarioRow | undefined;
}

export function createScenario(name: string, params: unknown, notes: string | null, now: string): ScenarioRow {
  const row: ScenarioRow = {
    scenario_id: randomUUID(),
    name,
    params_json: JSON.stringify(params),
    created_at: now,
    notes,
  };
  getDb()
    .prepare(`INSERT INTO scenarios (scenario_id, name, params_json, created_at, notes) VALUES (@scenario_id, @name, @params_json, @created_at, @notes)`)
    .run(row);
  return row;
}

export function deleteScenario(scenarioId: string): void {
  getDb().prepare(`DELETE FROM scenarios WHERE scenario_id = ?`).run(scenarioId);
}
