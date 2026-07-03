import { describe, expect, it } from "vitest";
import { lowBalanceWindows, projectBalances } from "./projection.js";

describe("projectBalances", () => {
  it("steps the balance on event days", () => {
    const points = projectBalances(
      1000,
      [
        { date: "2026-07-01", amount: 2000, label: "pay" },
        { date: "2026-07-03", amount: -1500, label: "rent" },
        { date: "2026-08-15", amount: -99, label: "outside range" },
      ],
      { start: "2026-07-01", end: "2026-07-05" },
    );
    expect(points.map((p) => p.value)).toEqual([3000, 3000, 1500, 1500, 1500]);
    expect(points[0]?.date).toBe("2026-07-01");
    expect(points.length).toBe(5);
  });
});

describe("lowBalanceWindows", () => {
  it("finds contiguous dips under the floor", () => {
    const projection = projectBalances(
      600,
      [
        { date: "2026-07-02", amount: -300, label: "bill" }, // 300 < 500
        { date: "2026-07-04", amount: 400, label: "pay" }, // 700 recovers
        { date: "2026-07-06", amount: -250, label: "bill" }, // 450 dips again
      ],
      { start: "2026-07-01", end: "2026-07-07" },
    );
    const windows = lowBalanceWindows(projection, 500);
    expect(windows).toEqual([
      { start: "2026-07-02", end: "2026-07-03", minBalance: 300 },
      { start: "2026-07-06", end: "2026-07-07", minBalance: 450 },
    ]);
  });
});
