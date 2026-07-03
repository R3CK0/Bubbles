import { describe, expect, it } from "vitest";
import {
  amortize,
  compareStrategies,
  effectiveMinPayment,
  payoffPlan,
  projectRevolvingInterest,
  repaymentSchedule,
} from "./debt.js";

describe("projectRevolvingInterest", () => {
  it("charges nothing when the statement cleared, even with new purchases", () => {
    const p = projectRevolvingInterest({
      statementBalance: 800,
      paidThisMonth: 800,
      currentBalance: 250, // new purchases after the payment
      apr: 19.99,
      hasGracePeriod: true,
    });
    expect(p.statementCleared).toBe(true);
    expect(p.remainingStatement).toBe(0);
    expect(p.projectedInterest).toBe(0);
  });

  it("accrues on the unpaid statement remainder at apr/12", () => {
    const p = projectRevolvingInterest({
      statementBalance: 1000,
      paidThisMonth: 400,
      currentBalance: 900,
      apr: 24,
      hasGracePeriod: true,
    });
    expect(p.statementCleared).toBe(false);
    expect(p.remainingStatement).toBe(600);
    expect(p.projectedInterest).toBe(12); // 600 × 2%/mo
  });

  it("lines of credit accrue on the live balance — no grace period", () => {
    const p = projectRevolvingInterest({
      statementBalance: 500,
      paidThisMonth: 500,
      currentBalance: 2000,
      apr: 12,
      hasGracePeriod: false,
    });
    expect(p.projectedInterest).toBe(20); // 2000 × 1%/mo
  });
});

describe("repaymentSchedule", () => {
  it("derives length and course interest from balance, rate, and budgeted payment", () => {
    const s = repaymentSchedule({ debtId: "d", name: "d", currentBalance: 1200, apr: 12, minPayment: null }, 100, "2026-08");
    expect(s).not.toBeNull();
    expect(s!.monthsToFree).toBe(13); // same schedule as the amortize test
    expect(s!.payoffMonth).toBe("2027-08");
    // Σ interest of the 13-row schedule
    const rows = amortize({ debtId: "d", name: "d", currentBalance: 1200, apr: 12, minPayment: null }, 100, "2026-08");
    expect(s!.totalInterest).toBeCloseTo(rows.reduce((t, r) => t + r.interest, 0), 2);
  });

  it("returns null when the payment can't cover interest", () => {
    expect(
      repaymentSchedule({ debtId: "d", name: "d", currentBalance: 10000, apr: 24, minPayment: null }, 100, "2026-08"),
    ).toBeNull();
  });

  it("a retired debt has an empty schedule", () => {
    const s = repaymentSchedule({ debtId: "d", name: "d", currentBalance: 0, apr: 10, minPayment: null }, 50, "2026-08");
    expect(s).toEqual({ monthlyPayment: 50, monthsToFree: 0, payoffMonth: "2026-08", totalInterest: 0, rows: [] });
  });
});

describe("amortize", () => {
  it("matches a hand-computed schedule (1200 @ 12%, $100/mo)", () => {
    // monthly rate 1%: m1 interest 12.00 principal 88.00 → 1112.00
    //                  m2 interest 11.12 principal 88.88 → 1023.12
    const rows = amortize({ debtId: "d", name: "d", currentBalance: 1200, apr: 12, minPayment: null }, 100, "2026-07");
    expect(rows[0]).toEqual({ month: "2026-07", interest: 12, principal: 88, balance: 1112 });
    expect(rows[1]).toEqual({ month: "2026-08", interest: 11.12, principal: 88.88, balance: 1023.12 });
    const last = rows[rows.length - 1]!;
    expect(last.balance).toBe(0);
    expect(rows.length).toBe(13); // n = −ln(1−.01·12)/ln(1.01) ≈ 12.85 → 13 payments
  });

  it("throws when the payment can't cover interest", () => {
    expect(() =>
      amortize({ debtId: "d", name: "d", currentBalance: 10000, apr: 24, minPayment: null }, 100, "2026-07"),
    ).toThrow(/never retires/);
  });
});

describe("effectiveMinPayment", () => {
  it("uses stated minimum, else 2% floor $25", () => {
    expect(effectiveMinPayment({ debtId: "d", name: "d", currentBalance: 5000, apr: 20, minPayment: 150 })).toBe(150);
    expect(effectiveMinPayment({ debtId: "d", name: "d", currentBalance: 5000, apr: 20, minPayment: null })).toBe(100);
    expect(effectiveMinPayment({ debtId: "d", name: "d", currentBalance: 500, apr: 20, minPayment: null })).toBe(25);
  });
});

describe("payoffPlan", () => {
  const debts = [
    { debtId: "cc", name: "Card", currentBalance: 3000, apr: 21, minPayment: 60 },
    { debtId: "loan", name: "Loan", currentBalance: 1000, apr: 6, minPayment: 50 },
  ];

  it("avalanche targets the higher APR first", () => {
    const plan = payoffPlan(debts, 500, "avalanche", "2026-07");
    // Month 1: card interest 52.50 → 3052.50, loan interest 5 → 1005.
    // Minimums: card 60 → 2992.50, loan 50 → 955. Surplus 390 → card → 2602.50.
    const card = plan.perDebt.find((d) => d.debtId === "cc")!;
    const loan = plan.perDebt.find((d) => d.debtId === "loan")!;
    expect(card.balances[0]).toBe(2602.5);
    expect(loan.balances[0]).toBe(955);
    expect(plan.debtFreeMonth).not.toBeNull();
  });

  it("snowball targets the smaller balance first", () => {
    const plan = payoffPlan(debts, 500, "snowball", "2026-07");
    const loan = plan.perDebt.find((d) => d.debtId === "loan")!;
    // Loan gets min 50 + surplus 390 = 440 against 1005 → 565.
    expect(loan.balances[0]).toBe(565);
  });

  it("avalanche never pays more interest than snowball", () => {
    const cmp = compareStrategies(debts, 500, "2026-07");
    expect(cmp.interestSaved).toBeGreaterThanOrEqual(0);
    expect(cmp.monthsSaved).toBeGreaterThanOrEqual(0);
  });

  it("rejects budgets below combined minimums", () => {
    expect(() => payoffPlan(debts, 100, "avalanche", "2026-07")).toThrow(/below/);
  });
});
