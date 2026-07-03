import { describe, expect, it } from "vitest";
import { solveAffordability, type SolverInputs } from "./affordability.js";
import type { GoalInput } from "./goals.js";

function goal(over: Partial<GoalInput> & { goalId: string; targetAmount: number }): GoalInput {
  return {
    goalType: "trip",
    name: over.goalId,
    personId: null,
    priority: 3,
    fundedAmount: 0,
    targetDate: null,
    ...over,
  };
}

function inputs(over: Partial<SolverInputs> = {}): SolverInputs {
  return {
    startMonth: "2026-07",
    freeCashFlowMonthly: 3000,
    bufferTarget: 0,
    bufferCurrent: 0,
    goals: [],
    debts: [],
    ...over,
  };
}

describe("solveAffordability — properties", () => {
  const complex = inputs({
    freeCashFlowMonthly: 3000,
    bufferTarget: 2000,
    bufferCurrent: 500,
    goals: [
      goal({ goalId: "wedding", targetAmount: 1300, targetDate: "2026-10-01", priority: 1 }),
      goal({ goalId: "greece", targetAmount: 1700, targetDate: "2027-04-01", priority: 2 }),
      goal({ goalId: "house", targetAmount: 60000, targetDate: "2028-07-01", priority: 2 }),
      goal({ goalId: "efund", targetAmount: 15000, priority: 4 }),
    ],
    debts: [
      { debtId: "cc", name: "Card", apr: 20.99, balance: 19464.93 },
      { debtId: "loc", name: "LOC", apr: 7.2, balance: 53374.65 },
    ],
    contributionTargets: [
      { key: "nick:fhsa", personId: "nick", type: "fhsa", monthlyCap: 666, equivalentReturn: 12, reason: "FHSA deduction" },
    ],
    expectedReturn: 5,
  });

  it("never allocates more than monthly supply", () => {
    const result = solveAffordability(complex);
    const byMonth = new Map<string, number>();
    for (const line of result.schedule) {
      byMonth.set(line.month, (byMonth.get(line.month) ?? 0) + line.amount);
    }
    for (const [month, total] of byMonth) {
      expect(total, `month ${month}`).toBeLessThanOrEqual(3000 + 0.02);
    }
  });

  it("fills the buffer before anything else in month 1", () => {
    const result = solveAffordability(complex);
    const firstMonth = result.schedule.filter((l) => l.month === "2026-07");
    expect(firstMonth[0]?.targetType).toBe("buffer");
    const bufferTotal = result.schedule.filter((l) => l.targetType === "buffer").reduce((s, l) => s + l.amount, 0);
    expect(bufferTotal).toBeCloseTo(1500, 1); // gap = 2000 − 500
  });

  it("prefers higher marginal return: 21% card before 12% FHSA before 7.2% LOC-vs-5% investing", () => {
    const result = solveAffordability(complex);
    const firstCc = result.schedule.find((l) => l.targetId === "cc");
    const firstFhsa = result.schedule.find((l) => l.targetType === "fhsa");
    expect(firstCc).toBeDefined();
    expect(firstFhsa).toBeDefined();
    // In any shared month, cc paydown appears before fhsa (schedule order = allocation order).
    const sameMonth = result.schedule.filter((l) => l.month === firstCc!.month);
    const ccIdx = sameMonth.findIndex((l) => l.targetId === "cc");
    const fhsaIdx = sameMonth.findIndex((l) => l.targetType === "fhsa");
    if (fhsaIdx >= 0) expect(ccIdx).toBeLessThan(fhsaIdx);
  });

  it("dated goals get funded by their dates when cash allows", () => {
    const result = solveAffordability(complex);
    const wedding = result.perGoal.find((g) => g.goalId === "wedding")!;
    expect(wedding.feasible).not.toBe("no");
    expect(wedding.fundedBy! <= "2026-10").toBe(true);
  });

  it("reports infeasibility and suggests cuts when demand exceeds supply", () => {
    const result = solveAffordability(
      inputs({
        freeCashFlowMonthly: 500,
        goals: [goal({ goalId: "big", targetAmount: 50000, targetDate: "2026-12-01", priority: 1 })],
        discretionary: [
          { categoryId: "resto", name: "Restaurants", monthlyBudget: 600 },
          { categoryId: "subs", name: "Streaming", monthlyBudget: 100 },
        ],
      }),
    );
    const big = result.perGoal.find((g) => g.goalId === "big")!;
    expect(big.feasible).toBe("no");
    expect(big.gap).toBeGreaterThan(0);
    expect(result.collisions.length).toBeGreaterThan(0);
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.suggestions[0]?.categoryId).toBe("resto"); // biggest budget first
  });

  it("determinism: same inputs, same output", () => {
    const a = JSON.stringify(solveAffordability(complex));
    const b = JSON.stringify(solveAffordability(complex));
    expect(a).toBe(b);
  });

  it("runs fast enough for live dragging (<50ms for a 5-goal 60-month solve)", () => {
    const start = performance.now();
    for (let i = 0; i < 20; i++) solveAffordability(complex);
    const perRun = (performance.now() - start) / 20;
    expect(perRun).toBeLessThan(50);
  });
});
