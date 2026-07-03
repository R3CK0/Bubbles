import { describe, expect, it } from "vitest";
import { detectRecurring, matchTransaction, normalizeMerchant, priceCreep, type RecurringEntry } from "./recurring.js";
import { tx } from "./fixtures.test.js";

describe("normalizeMerchant", () => {
  it("strips store numbers and noise", () => {
    expect(normalizeMerchant("NETFLIX #1234")).toBe("netflix");
    expect(normalizeMerchant("Hydro-Québec 000123")).toBe("hydro qu bec");
    expect(normalizeMerchant("Tim Hortons")).toBe("tim hortons");
  });
});

describe("detectRecurring", () => {
  it("detects a monthly subscription from 4 stable charges", () => {
    const txs = ["2026-03-05", "2026-04-05", "2026-05-05", "2026-06-05"].map((date, i) =>
      tx({ transactionId: `n${i}`, amount: 27.59, date, merchantName: "NETFLIX #001" }),
    );
    const [candidate] = detectRecurring(txs);
    expect(candidate?.frequency).toBe("monthly");
    expect(candidate?.expectedAmount).toBe(27.59);
    expect(candidate?.anchorDate).toBe("2026-06-05");
    expect(candidate?.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("ignores erratic merchants and inflows", () => {
    const erratic = [
      tx({ transactionId: "e1", amount: 12, date: "2026-03-01", merchantName: "Cafe" }),
      tx({ transactionId: "e2", amount: 80, date: "2026-03-04", merchantName: "Cafe" }),
      tx({ transactionId: "e3", amount: 33, date: "2026-05-28", merchantName: "Cafe" }),
      tx({ transactionId: "i1", amount: -500, date: "2026-04-01", merchantName: "Employer" }),
      tx({ transactionId: "i2", amount: -500, date: "2026-05-01", merchantName: "Employer" }),
      tx({ transactionId: "i3", amount: -500, date: "2026-06-01", merchantName: "Employer" }),
    ];
    expect(detectRecurring(erratic)).toEqual([]);
  });
});

const ENTRY: RecurringEntry = {
  rpId: "rp-netflix",
  name: "Netflix",
  expectedAmount: 27.59,
  amountTolerance: 0.05,
  frequency: "monthly",
  intervalDays: null,
  anchorDate: "2026-06-05",
  nextDueDate: "2026-07-05",
  endDate: null,
};

describe("matchTransaction", () => {
  it("matches by name + amount + due window", () => {
    const hit = matchTransaction(tx({ transactionId: "t", amount: 27.59, date: "2026-07-06", merchantName: "NETFLIX #99" }), [ENTRY]);
    expect(hit?.rpId).toBe("rp-netflix");
  });

  it("matches price-crept charges (then creep flags them)", () => {
    const hit = matchTransaction(tx({ transactionId: "t", amount: 29.99, date: "2026-07-05", merchantName: "Netflix" }), [ENTRY]);
    expect(hit?.rpId).toBe("rp-netflix");
  });

  it("rejects far-off dates and amounts", () => {
    expect(matchTransaction(tx({ transactionId: "t", amount: 27.59, date: "2026-07-20", merchantName: "Netflix" }), [ENTRY])).toBeNull();
    expect(matchTransaction(tx({ transactionId: "t", amount: 55, date: "2026-07-05", merchantName: "Netflix" }), [ENTRY])).toBeNull();
  });
});

describe("priceCreep", () => {
  it("flags beyond tolerance, stays quiet within it", () => {
    expect(priceCreep(29.99, ENTRY)).toEqual({ delta: 2.4, pct: 8.7 });
    expect(priceCreep(28.5, ENTRY)).toBeNull(); // within max(5%, $0.50)
    expect(priceCreep(27.59, ENTRY)).toBeNull();
  });
});
