import { describe, expect, it } from "vitest";
import { buildFxTable, roundCents, signedFlow, toCAD } from "./money.js";

describe("money", () => {
  it("rounds to cents", () => {
    expect(roundCents(0.1 + 0.2)).toBe(0.3);
    expect(roundCents(69.6325)).toBe(69.63);
  });

  it("signedFlow flips Plaid's outflow-positive convention", () => {
    expect(signedFlow({ amount: 42.1 })).toBe(-42.1);
    expect(signedFlow({ amount: -5000 })).toBe(5000);
  });

  it("converts with carry-forward rates", () => {
    const fx = buildFxTable([
      { date: "2026-06-01", baseCcy: "USD", quoteCcy: "CAD", rate: 1.35 },
      { date: "2026-06-03", baseCcy: "USD", quoteCcy: "CAD", rate: 1.4 },
    ]);
    expect(toCAD(100, "USD", "2026-06-02", fx)).toBe(135);
    expect(toCAD(100, "USD", "2026-06-05", fx)).toBe(140);
    expect(toCAD(100, "USD", "2026-05-01", fx)).toBe(135); // before table: earliest
    expect(toCAD(100, "CAD", "2026-06-02", fx)).toBe(100);
    expect(() => toCAD(100, "EUR", "2026-06-02", fx)).toThrow();
  });
});
