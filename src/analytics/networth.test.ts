import { describe, expect, it } from "vitest";
import { emergencyFundMonths, milestones, netWorthSeries } from "./networth.js";

const ACCOUNTS = [
  { accountId: "chq", personId: "nick" as string | null, type: "depository", name: "Chequing" },
  { accountId: "cc", personId: "nick" as string | null, type: "credit", name: "Card" },
  { accountId: "inv", personId: "shanthi" as string | null, type: "investment", name: "TFSA" },
];

describe("netWorthSeries", () => {
  it("carries forward, mirrors liabilities, folds in manual assets/debts", () => {
    const series = netWorthSeries(
      [
        { accountId: "chq", date: "2026-06-01", balance: 5000 },
        { accountId: "cc", date: "2026-06-01", balance: 2000 },
        { accountId: "inv", date: "2026-06-01", balance: 10000 },
        { accountId: "chq", date: "2026-06-03", balance: 6000 }, // cc & inv carry forward
      ],
      ACCOUNTS,
      [{ assetId: "bldg", personId: "shanthi", name: "Buildings", date: "2026-06-02", value: 130000 }],
      [{ debtId: "loan", personId: "nick", name: "Student loan", balance: 27000 }],
      "combined",
    );
    expect(series.dates).toEqual(["2026-06-01", "2026-06-02", "2026-06-03"]);
    // day1: assets 15000, debts 2000+27000
    expect(series.net[0]?.value).toBe(15000 - 29000);
    // day2: buildings appears → assets 145000
    expect(series.assets[1]?.value).toBe(145000);
    // day3: chq updates to 6000
    expect(series.net[2]?.value).toBe(146000 - 29000);
  });

  it("person lens keeps own + joint sources only", () => {
    const series = netWorthSeries(
      [
        { accountId: "chq", date: "2026-06-01", balance: 5000 },
        { accountId: "inv", date: "2026-06-01", balance: 10000 },
      ],
      ACCOUNTS,
      [],
      [],
      "shanthi",
    );
    expect(series.assets[0]?.value).toBe(10000);
  });
});

describe("milestones", () => {
  it("flags upward crossings only", () => {
    const net = [
      { date: "2026-01-01", value: 90_000 },
      { date: "2026-02-01", value: 102_000 }, // crosses 100k
      { date: "2026-03-01", value: 97_000 }, // dips — no flag
      { date: "2026-04-01", value: 101_000 }, // re-cross already flagged tier: no new flag
      { date: "2026-05-01", value: 126_000 }, // crosses 125k
    ];
    expect(milestones(net)).toEqual([
      { date: "2026-02-01", value: 100_000 },
      { date: "2026-05-01", value: 125_000 },
    ]);
  });
});

describe("emergencyFundMonths", () => {
  it("months of essentials covered", () => {
    expect(emergencyFundMonths(20000, 6700)).toBe(3);
    expect(emergencyFundMonths(20000, 0)).toBeNull();
  });
});
