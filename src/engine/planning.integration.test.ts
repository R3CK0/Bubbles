/**
 * Integration: goals → solve → approve plan lifecycle over an in-memory DB.
 */
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _setDbForTests, getDb } from "../db/db.js";
import { runMigrations } from "../db/migrator.js";
import { upsertCategory, createBudgetVersion } from "../db/repositories/budgeting.js";
import { createGoal, approveSolveAsPlan, getActivePlan, getGoalsView, solve } from "./planningService.js";
import type { EngineContext } from "./context.js";

const NOW = "2026-07-01T08:00:00.000Z";

function ctx(): EngineContext {
  return {
    lens: "combined",
    month: "2026-07",
    range: { start: "2026-07-01", end: "2026-07-31" },
    persons: [],
    personNames: new Map(),
    today: "2026-07-01",
  };
}

beforeAll(() => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  _setDbForTests(db);

  upsertCategory({ category_id: "income", parent_id: null, name: "Income", kind: "income", sort_order: 0, archived: 0 });
  upsertCategory({ category_id: "essentials", parent_id: null, name: "Essentials", kind: "expense", sort_order: 1, archived: 0 });
  createBudgetVersion(
    "test",
    "2026-07-01",
    null,
    [
      { category_id: "income", person_id: null, monthly_amount: 10000 },
      { category_id: "essentials", person_id: null, monthly_amount: 6000 },
    ],
    NOW,
  );
});

afterAll(() => _setDbForTests(null));

describe("planning lifecycle", () => {
  it("creates goals, solves with budget-derived free cash flow, approves a plan", () => {
    createGoal({ goalType: "trip", category: "spending", name: "Greece", targetAmount: 1700, targetDate: "2026-12-01", priority: 2 });
    createGoal({ goalType: "event", category: "spending", name: "Wedding", targetAmount: 1300, targetDate: "2026-09-01", priority: 1 });

    const view = getGoalsView(ctx());
    expect(view.goals.length).toBe(2);
    expect(view.solve.perGoal.every((g) => g.feasible !== "no")).toBe(true); // 4000/mo covers both

    const { plan, lines } = approveSolveAsPlan(ctx(), "Baseline plan");
    expect(plan.status).toBe("active");
    expect(lines).toBeGreaterThan(0);

    const active = getActivePlan();
    expect(active?.plan.plan_id).toBe(plan.plan_id);
    const julyGoalLines = active!.lines.filter((l) => l.month === "2026-07" && l.target_type === "goal");
    expect(julyGoalLines.length).toBeGreaterThan(0);

    // Approving a second plan supersedes the first.
    const second = approveSolveAsPlan(ctx(), "Revised plan");
    expect(getActivePlan()?.plan.plan_id).toBe(second.plan.plan_id);
    const statuses = getDb().prepare(`SELECT status, COUNT(*) AS n FROM plans GROUP BY status`).all() as { status: string; n: number }[];
    expect(statuses.find((s) => s.status === "active")?.n).toBe(1);
    expect(statuses.find((s) => s.status === "superseded")?.n).toBe(1);
  });

  it("goal shifts change feasibility in preview without persisting", () => {
    const tight = solve(ctx(), { freeCashFlowMonthly: 100, goalShifts: [{ goalId: getGoalsView(ctx()).goals[0]!.goal_id, targetDate: "2026-08-01" }] });
    expect(tight.perGoal.some((g) => g.feasible === "no")).toBe(true);
    // real goals untouched
    expect(getGoalsView(ctx()).solve.perGoal.every((g) => g.feasible !== "no")).toBe(true);
  });
});
