import { describe, expect, it } from "vitest";
import {
  allocation,
  contributionVsGrowth,
  moneyWeightedReturn,
  portfolioSeries,
  timeWeightedReturn,
  type HoldingPoint,
} from "./portfolio.js";

function h(over: Partial<HoldingPoint> & { date: string; value: number; securityId: string }): HoldingPoint {
  return { accountId: "acc-inv", personId: "nick", quantity: 1, costBasis: null, ...over };
}

describe("portfolioSeries", () => {
  it("sums holdings per date under the lens", () => {
    const series = portfolioSeries(
      [
        h({ date: "2026-06-01", value: 100, securityId: "a" }),
        h({ date: "2026-06-01", value: 200, securityId: "b" }),
        h({ date: "2026-06-02", value: 320, securityId: "a" }),
        h({ date: "2026-06-01", value: 999, securityId: "c", personId: "shanthi" }),
      ],
      "nick",
    );
    expect(series).toEqual([
      { date: "2026-06-01", value: 300 },
      { date: "2026-06-02", value: 320 },
    ]);
  });
});

describe("contributionVsGrowth", () => {
  it("splits the curve into money-in vs market", () => {
    const series = [
      { date: "2026-06-01", value: 1000 },
      { date: "2026-06-02", value: 2050 }, // +1000 contribution, +50 market
      { date: "2026-06-03", value: 2100 }, // +50 market
    ];
    const d = contributionVsGrowth(series, [{ date: "2026-06-02", amount: 1000 }]);
    expect(d.contributions.map((p) => p.value)).toEqual([0, 1000, 1000]);
    expect(d.growth.map((p) => p.value)).toEqual([0, 50, 100]);
  });
});

describe("returns", () => {
  it("TWR strips out the contribution", () => {
    const series = [
      { date: "2026-06-01", value: 1000 },
      { date: "2026-06-02", value: 2050 },
      { date: "2026-06-03", value: 2091 }, // +2%
    ];
    const twr = timeWeightedReturn(series, [{ date: "2026-06-02", amount: 1000 }]);
    // day1: 2050/(1000+1000)=1.025, day2: 2091/2050=1.02 → 4.55%
    expect(twr).toBeCloseTo(0.0455, 3);
  });

  it("MWR: flat portfolio with no growth returns ~0", () => {
    const series = [
      { date: "2026-01-01", value: 1000 },
      { date: "2026-12-31", value: 2000 },
    ];
    const mwr = moneyWeightedReturn(series, [{ date: "2026-07-01", amount: 1000 }]);
    expect(mwr).not.toBeNull();
    expect(Math.abs(mwr!)).toBeLessThan(0.01);
  });

  it("MWR: 10% annual growth on a single deposit", () => {
    const series = [
      { date: "2026-01-01", value: 1000 },
      { date: "2027-01-01", value: 1100 },
    ];
    expect(moneyWeightedReturn(series, [])).toBeCloseTo(0.1, 2);
  });
});

describe("allocation", () => {
  it("groups by class and computes drift vs targets", () => {
    const holdings = [
      h({ date: "2026-06-02", value: 8000, securityId: "xeqt" }),
      h({ date: "2026-06-02", value: 2000, securityId: "zag" }),
      h({ date: "2026-06-01", value: 7000, securityId: "xeqt" }), // stale date ignored
    ];
    const secs = [
      { securityId: "xeqt", ticker: "XEQT", name: "Equity ETF", secType: "etf" },
      { securityId: "zag", ticker: "ZAG", name: "Bond ETF", secType: "fixed income" },
    ];
    const slices = allocation(holdings, secs, { equity: 0.7, fixed_income: 0.3 }, "combined");
    const equity = slices.find((s) => s.class === "equity")!;
    expect(equity.weight).toBe(0.8);
    expect(equity.drift).toBeCloseTo(0.1, 3);
    const fixed = slices.find((s) => s.class === "fixed_income")!;
    expect(fixed.drift).toBeCloseTo(-0.1, 3);
  });
});
