import { describe, expect, it } from "vitest";
import { eventBudget, houseAffordability, mortgagePayment, requiredMonthly } from "./goals.js";

describe("requiredMonthly", () => {
  const base = { goalId: "g", goalType: "trip", name: "g", personId: null, priority: 3 };

  it("spreads the remainder across months to target", () => {
    expect(requiredMonthly({ ...base, targetAmount: 1700, fundedAmount: 500, targetDate: "2026-12-15" }, "2026-07")).toBe(200); // 1200 / 6 months (Jul..Dec)
  });

  it("past-due goals demand everything now; open-ended return null", () => {
    expect(requiredMonthly({ ...base, targetAmount: 1000, fundedAmount: 0, targetDate: "2026-06-01" }, "2026-07")).toBe(1000);
    expect(requiredMonthly({ ...base, targetAmount: 1000, fundedAmount: 0, targetDate: null }, "2026-07")).toBeNull();
  });
});

describe("mortgagePayment", () => {
  it("matches the annuity formula", () => {
    // 400k @ 5.25% / 25y → r=0.004375, n=300 → ~2397/mo
    expect(mortgagePayment(400_000, 5.25, 25)).toBeCloseTo(2396.98, 0);
  });
});

describe("houseAffordability", () => {
  it("applies the stress test and GDS/TDS", () => {
    const res = houseAffordability({
      rate: 4.5,
      grossAnnualIncome: 163_512, // ≈ their combined
      monthlyDebtPayments: 900,
      downPaymentPct: 0.2,
    });
    expect(res.qualifyingRate).toBe(6.5);
    expect(res.maxPrice).toBeGreaterThan(300_000);
    expect(res.maxMortgage).toBeCloseTo(res.maxPrice * 0.8, 0);
    // GDS room = 13626·0.39 − 150 ≈ 5164; TDS room = 13626·0.44 − 150 − 900 ≈ 4945 → TDS binds
    expect(res.bindingConstraint).toBe("TDS");
  });

  it("higher offered rates only bind above the 5.25 floor", () => {
    const low = houseAffordability({ rate: 2, grossAnnualIncome: 120000, monthlyDebtPayments: 0 });
    expect(low.qualifyingRate).toBe(5.25);
  });
});

describe("eventBudget", () => {
  it("committed / paid / remaining, ignoring cancelled", () => {
    expect(
      eventBudget([
        { amount: 300, status: "paid" },
        { amount: 1000, status: "planned" },
        { amount: 500, status: "cancelled" },
      ]),
    ).toEqual({ committed: 1300, paid: 300, remaining: 1000 });
  });
});
