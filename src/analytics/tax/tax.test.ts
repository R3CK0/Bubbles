/**
 * Golden tests for the 2026 estimator, hand-computed from the published
 * parameters in db/seeds/taxTables2026.ts.
 */
import { describe, expect, it } from "vitest";
import { TAX_TABLES_2026 } from "../../db/seeds/taxTables2026.js";
import { estimateTax, bracketGlasses, householdEstimate } from "./estimator.js";
import { payrollContributions } from "./payroll.js";
import { optimizeContributions } from "./optimizer.js";
import { enumerateStrategies } from "./couple.js";
import type { TaxInput } from "./types.js";

const T = TAX_TABLES_2026;

function input(over: Partial<TaxInput> & { personId: string; employmentIncome: number }): TaxInput {
  return {
    taxYear: 2026,
    rentalNet: 0,
    interestIncome: 0,
    eligibleDividends: 0,
    capitalGains: 0,
    rrspDeduction: 0,
    fhsaDeduction: 0,
    donations: 0,
    medicalExpenses: 0,
    withholdingPaid: 0,
    ...over,
  };
}

describe("estimateTax — golden: $85,306 salary (Nick-like)", () => {
  // Hand computation:
  // Federal gross: 58,523·0.14 + (85,306−58,523)·0.205 = 8,193.22 + 5,490.52 = 13,683.74
  // Federal credits: BPA 16,452·0.14 = 2,303.28 → 11,380.46
  // After 16.5% abatement: 11,380.46·0.835 = 9,502.68
  // QC gross: 54,345·0.14 + (85,306−54,345)·0.19 = 7,608.30 + 5,882.59 = 13,490.89
  // QC credits: 18,952·0.14 = 2,653.28 → 10,837.61
  // Total income tax ≈ 20,340.29
  const r = estimateTax(input({ personId: "nick", employmentIncome: 85_306 }), T);

  it("federal matches hand computation", () => {
    expect(r.federal.grossTax).toBeCloseTo(13_683.74, 1);
    expect(r.federal.netTax).toBeCloseTo(9_502.68, 0);
  });

  it("quebec matches hand computation", () => {
    expect(r.quebec.grossTax).toBeCloseTo(13_490.89, 1);
    expect(r.quebec.netTax).toBeCloseTo(10_837.61, 0);
  });

  it("total, marginal, average", () => {
    expect(r.totalIncomeTax).toBeCloseTo(20_340.29, 0);
    // Marginal: fed 20.5%·0.835 + QC 19% = 17.12% + 19% = 36.12%
    expect(r.marginalRate).toBeCloseTo(0.3612, 2);
    expect(r.averageRate).toBeCloseTo(20_340.29 / 85_306, 2);
  });

  it("payroll: QPP capped at YMPE, QPIP and EI on full salary", () => {
    // QPP: (74,600−3,500)·0.063 = 4,479.30 + QPP2 (85,000−74,600)·0.04 = 416 → 4,895.30
    // QPIP: 85,306·0.0043 = 366.82 ; EI: 68,900·0.013 = 895.70 (capped)
    expect(r.payroll.qpp).toBeCloseTo(4_895.3, 1);
    expect(r.payroll.qpip).toBeCloseTo(366.82, 1);
    expect(r.payroll.ei).toBeCloseTo(895.7, 1);
  });
});

describe("estimateTax — deductions and balance", () => {
  it("an $8k FHSA deduction saves at the marginal rate", () => {
    const base = estimateTax(input({ personId: "n", employmentIncome: 85_306 }), T);
    const deducted = estimateTax(input({ personId: "n", employmentIncome: 85_306, fhsaDeduction: 8_000 }), T);
    const saved = base.totalIncomeTax - deducted.totalIncomeTax;
    expect(saved).toBeCloseTo(8_000 * 0.3612, 0);
  });

  it("withholding drives owing vs refund", () => {
    const r = estimateTax(input({ personId: "n", employmentIncome: 85_306, withholdingPaid: 22_000 }), T);
    expect(r.balance).toBeCloseTo(r.totalIncomeTax - 22_000, 1);
    expect(r.balance).toBeLessThan(0); // refund
  });

  it("low income pays zero after BPA credits", () => {
    const r = estimateTax(input({ personId: "n", employmentIncome: 15_000 }), T);
    expect(r.federal.netTax).toBe(0);
    expect(r.quebec.netTax).toBe(0);
  });

  it("bracket glasses fill in order", () => {
    const glasses = bracketGlasses(input({ personId: "n", employmentIncome: 85_306 }), T);
    const fed = glasses.find((g) => g.jurisdiction === "CA")!;
    expect(fed.tiers[0]?.filled).toBe(58_523);
    expect(fed.tiers[1]?.filled).toBeCloseTo(85_306 - 58_523, 1);
    expect(fed.tiers[2]?.filled).toBe(0);
  });
});

describe("householdEstimate", () => {
  it("sums the couple", () => {
    const a = estimateTax(input({ personId: "a", employmentIncome: 85_306 }), T);
    const b = estimateTax(input({ personId: "b", employmentIncome: 66_206 }), T);
    const h = householdEstimate([a, b]);
    expect(h.totalIncomeTax).toBeCloseTo(a.totalIncomeTax + b.totalIncomeTax, 1);
    expect(h.totalIncome).toBeCloseTo(151_512, 1);
  });
});

describe("payroll standalone", () => {
  it("below-exemption earnings contribute nothing to QPP", () => {
    const p = payrollContributions(3_000, T.CA.payroll!);
    expect(p.qpp).toBe(0);
    expect(p.qpip).toBeCloseTo(12.9, 1);
  });
});

describe("optimizeContributions", () => {
  const persons = [
    { input: input({ personId: "nick", employmentIncome: 85_306 }), roomFhsa: 8_000, roomRrsp: 15_000, roomTfsa: 20_000 },
    { input: input({ personId: "shanthi", employmentIncome: 66_206 }), roomFhsa: 8_000, roomRrsp: 10_000, roomTfsa: 25_000 },
  ];

  it("fills higher-marginal-rate room first, FHSA before RRSP on ties", () => {
    const r = optimizeContributions({ persons, deployableCash: 10_000, houseGoalActive: true, monthsRemaining: 6 }, T);
    const nick = r.allocations.find((a) => a.personId === "nick")!;
    // Nick's marginal (36.1%) > Shanthi's (~31.6%): his FHSA fills first.
    expect(nick.fhsa).toBe(8_000);
    expect(r.totalDeployed).toBe(10_000);
    expect(r.totalTaxSaved).toBeGreaterThan(3_000);
    expect(r.monthlySchedule.every((s) => s.monthly > 0)).toBe(true);
  });

  it("overflows to TFSA once deductible room is gone", () => {
    const small = [{ input: input({ personId: "n", employmentIncome: 85_306 }), roomFhsa: 1_000, roomRrsp: 0, roomTfsa: 50_000 }];
    const r = optimizeContributions({ persons: small, deployableCash: 5_000, houseGoalActive: false, monthsRemaining: 12 }, T);
    expect(r.allocations[0]?.fhsa).toBe(1_000);
    expect(r.allocations[0]?.tfsa).toBe(4_000);
  });
});

describe("enumerateStrategies", () => {
  it("prices spousal RRSP and credit pooling for an uneven couple", () => {
    const strategies = enumerateStrategies(
      {
        a: input({ personId: "nick", employmentIncome: 120_000, donations: 300 }),
        b: input({ personId: "shanthi", employmentIncome: 55_000, donations: 300 }),
        roomRrspA: 20_000,
        roomRrspB: 20_000,
        plannedRrsp: 10_000,
      },
      T,
    );
    const spousal = strategies.find((s) => s.kind === "spousal_rrsp");
    expect(spousal).toBeDefined();
    expect(spousal!.dollarImpact).toBeGreaterThan(100);
    const pooling = strategies.find((s) => s.kind === "credit_pooling");
    expect(pooling).toBeDefined();
    expect(pooling!.dollarImpact).toBeGreaterThan(0);
    // sorted by impact
    expect(strategies[0]!.dollarImpact).toBeGreaterThanOrEqual(strategies[strategies.length - 1]!.dollarImpact);
  });
});
