import { describe, expect, it } from "vitest";
import { buildSankey, computeCashflow, fluxMatrix } from "./cashflow.js";
import { CATEGORIES, tx } from "./fixtures.test.js";

const RANGE = { start: "2026-06-01", end: "2026-06-30" };

const TXS = [
  tx({ transactionId: "t1", amount: -5000, date: "2026-06-01", categoryId: "income-salary", personId: "nick" }),
  tx({ transactionId: "t2", amount: -3000, date: "2026-06-01", categoryId: "income-salary", personId: "shanthi" }),
  tx({ transactionId: "t3", amount: -1000, date: "2026-06-05", categoryId: "income-buildings", personId: "nick" }),
  tx({ transactionId: "t4", amount: 120.5, date: "2026-06-08", categoryId: "essentials-groceries", merchantName: "Metro" }),
  tx({ transactionId: "t5", amount: 60, date: "2026-06-09", categoryId: "essentials-restaurants", personId: "shanthi" }),
  tx({ transactionId: "t6", amount: 833, date: "2026-06-10", isTransfer: true }),
  tx({ transactionId: "t7", amount: 300, date: "2026-06-11", reimbursedBy: "work" }),
  tx({ transactionId: "t8", amount: 40, date: "2026-07-02", categoryId: "essentials-groceries" }), // outside range
];

describe("computeCashflow", () => {
  it("excludes transfers, reimbursed rows, and out-of-range rows", () => {
    const s = computeCashflow(TXS, CATEGORIES, "combined", RANGE);
    expect(s.income).toBe(9000);
    expect(s.spend).toBe(180.5);
    expect(s.net).toBe(8819.5);
  });

  it("applies the person lens (own + joint rows)", () => {
    const s = computeCashflow(TXS, CATEGORIES, "shanthi", RANGE);
    expect(s.income).toBe(3000);
    expect(s.spend).toBe(60);
  });

  it("uncategorized inflow counts as income, outflow as spend", () => {
    const s = computeCashflow(
      [tx({ transactionId: "u1", amount: -50, date: "2026-06-02" }), tx({ transactionId: "u2", amount: 25, date: "2026-06-03" })],
      CATEGORIES,
      "combined",
      RANGE,
    );
    expect(s.income).toBe(50);
    expect(s.spend).toBe(25);
    expect(s.byCategory[0]?.name).toBe("Uncategorized");
  });
});

describe("buildSankey", () => {
  it("balances: household inflow equals outflow + unallocated", () => {
    const names = new Map([
      ["nick", "Nick"],
      ["shanthi", "Shanthi"],
    ]);
    const g = buildSankey(TXS, CATEGORIES, names, "combined", RANGE);
    const into = g.links.filter((l) => l.target === "Household").reduce((s, l) => s + l.value, 0);
    const out = g.links.filter((l) => l.source === "Household").reduce((s, l) => s + l.value, 0);
    expect(into).toBeCloseTo(out, 2);
    // named income stream + person streams both present
    expect(g.links.find((l) => l.source === "Buildings")?.value).toBe(1000);
    expect(g.links.find((l) => l.source === "Nick")?.value).toBe(5000);
    // group → child fan-out
    expect(g.links.find((l) => l.source === "Essentials" && l.target === "Groceries")?.value).toBe(120.5);
    expect(g.links.find((l) => l.target === "Unallocated")?.value).toBeCloseTo(8819.5, 2);
  });
});

describe("fluxMatrix", () => {
  it("buckets month × top-level category", () => {
    const m = fluxMatrix(TXS, CATEGORIES, ["2026-06", "2026-07"], "combined");
    expect(m.cells.find((c) => c.month === "2026-06" && c.categoryId === "essentials")?.value).toBe(180.5);
    expect(m.cells.find((c) => c.month === "2026-07" && c.categoryId === "essentials")?.value).toBe(40);
    expect(m.cells.find((c) => c.month === "2026-06" && c.categoryId === "income")?.value).toBe(9000);
  });
});
