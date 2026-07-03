import { describe, expect, it } from "vitest";
import { budgetVsActual, decomposeVariance } from "./variance.js";
import { CATEGORIES, tx } from "./fixtures.test.js";

describe("budgetVsActual", () => {
  const lines = [
    { categoryId: "essentials-groceries", personId: "nick" as string | null, monthlyAmount: 1000 },
    { categoryId: "essentials-groceries", personId: "shanthi" as string | null, monthlyAmount: 200 },
    { categoryId: "essentials-restaurants", personId: null, monthlyAmount: 600 },
  ];

  it("combines lines under the lens and computes variance + pace", () => {
    const actuals = new Map([
      ["essentials-groceries", 800],
      ["essentials-restaurants", 700],
    ]);
    const rows = budgetVsActual(lines, actuals, CATEGORIES, "combined", 0.5);
    const groceries = rows.find((r) => r.categoryId === "essentials-groceries")!;
    expect(groceries.budget).toBe(1200);
    expect(groceries.variance).toBe(-400);
    expect(groceries.pace).toBeCloseTo(800 / 600, 2); // 1.33: spending fast
    const resto = rows.find((r) => r.categoryId === "essentials-restaurants")!;
    expect(resto.variance).toBe(100);
  });

  it("person lens keeps own + joint budget lines", () => {
    const rows = budgetVsActual(lines, new Map(), CATEGORIES, "shanthi", 1);
    expect(rows.find((r) => r.categoryId === "essentials-groceries")!.budget).toBe(200);
    expect(rows.find((r) => r.categoryId === "essentials-restaurants")!.budget).toBe(600); // joint
  });
});

describe("decomposeVariance", () => {
  const baseline = [
    tx({ transactionId: "b1", amount: 27.59, date: "2026-03-05", merchantName: "Netflix" }),
    tx({ transactionId: "b2", amount: 27.59, date: "2026-04-05", merchantName: "Netflix" }),
    tx({ transactionId: "b3", amount: 27.59, date: "2026-05-05", merchantName: "Netflix" }),
    tx({ transactionId: "b4", amount: 100, date: "2026-05-10", merchantName: "Metro" }),
    tx({ transactionId: "b5", amount: 100, date: "2026-04-10", merchantName: "Metro" }),
    tx({ transactionId: "b6", amount: 100, date: "2026-03-10", merchantName: "Metro" }),
  ];

  it("detects price increases", () => {
    const current = [tx({ transactionId: "c1", amount: 29.99, date: "2026-06-05", merchantName: "Netflix" })];
    const drivers = decomposeVariance(current, baseline, 3);
    const netflix = drivers.find((d) => d.merchant === "netflix")!;
    expect(netflix.kind).toBe("price_increase");
    expect(netflix.delta).toBeCloseTo(2.4, 2);
  });

  it("detects new merchants and one-offs", () => {
    const current = [
      tx({ transactionId: "c1", amount: 45, date: "2026-06-02", merchantName: "New Cafe" }),
      tx({ transactionId: "c2", amount: 900, date: "2026-06-03", merchantName: "Best Buy" }),
    ];
    const drivers = decomposeVariance(current, baseline, 3);
    expect(drivers.find((d) => d.merchant === "new cafe")?.kind).toBe("new_merchant");
    expect(drivers.find((d) => d.merchant === "best buy")?.kind).toBe("one_off");
    expect(drivers[0]?.merchant).toBe("best buy"); // sorted by delta
  });

  it("detects frequency increases", () => {
    const current = [
      tx({ transactionId: "c1", amount: 100, date: "2026-06-01", merchantName: "Metro" }),
      tx({ transactionId: "c2", amount: 100, date: "2026-06-08", merchantName: "Metro" }),
      tx({ transactionId: "c3", amount: 100, date: "2026-06-15", merchantName: "Metro" }),
    ];
    const drivers = decomposeVariance(current, baseline, 3);
    expect(drivers.find((d) => d.merchant === "metro")?.kind).toBe("frequency_increase");
  });
});
