import { describe, expect, it } from "vitest";
import {
  addMonths,
  addMonthsToDate,
  daysInMonth,
  expandRecurrence,
  monthWindow,
  monthsBetween,
  nextOccurrence,
} from "./calendar.js";

describe("calendar", () => {
  it("month arithmetic", () => {
    expect(addMonths("2026-01", 13)).toBe("2027-02");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(monthsBetween("2025-11", "2026-02")).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    expect(daysInMonth("2026-02")).toBe(28);
    expect(daysInMonth("2024-02")).toBe(29);
    expect(monthWindow("2026-06")).toEqual({ start: "2026-06-01", end: "2026-06-30" });
  });

  it("clamps day-of-month when adding months", () => {
    expect(addMonthsToDate("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsToDate("2026-01-31", 2)).toBe("2026-03-31");
  });

  it("expands monthly recurrences with clamping", () => {
    const hits = expandRecurrence("monthly", "2026-01-31", { start: "2026-02-01", end: "2026-04-30" });
    expect(hits).toEqual(["2026-02-28", "2026-03-31", "2026-04-30"]);
  });

  it("expands biweekly recurrences from a distant anchor", () => {
    // 2025-01-03 + 37×14d = 2026-06-05; next is 06-19, then 07-03 (outside).
    const hits = expandRecurrence("biweekly", "2025-01-03", { start: "2026-06-01", end: "2026-06-30" });
    expect(hits).toEqual(["2026-06-05", "2026-06-19"]);
  });

  it("respects endDate and custom intervals", () => {
    expect(expandRecurrence("monthly", "2026-01-15", { start: "2026-01-01", end: "2026-12-31" }, "2026-03-31")).toEqual([
      "2026-01-15",
      "2026-02-15",
      "2026-03-15",
    ]);
    expect(expandRecurrence("custom", "2026-06-01", { start: "2026-06-01", end: "2026-06-20" }, null, 10)).toEqual([
      "2026-06-01",
      "2026-06-11",
    ]);
    expect(() => expandRecurrence("custom", "2026-06-01", { start: "2026-06-01", end: "2026-06-20" })).toThrow();
  });

  it("nextOccurrence is strictly after the given date", () => {
    expect(nextOccurrence("monthly", "2026-06-01", "2026-06-01")).toBe("2026-07-01");
    expect(nextOccurrence("monthly", "2026-06-01", "2026-06-30")).toBe("2026-07-01");
  });
});
