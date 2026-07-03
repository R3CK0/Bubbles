/**
 * Integration: manual positions → prices → snapshot rebuild → portfolio
 * series/allocation → reconciliation. Market fetches are stubbed.
 */
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _setDbForTests, getDb } from "../db/db.js";
import { runMigrations } from "../db/migrator.js";
import { upsertPrices } from "../db/repositories/investments.js";
import { upsertFxRates } from "../db/repositories/history.js";
import { getPositionsView, rebuildSnapshots, savePosition } from "./positionsService.js";
import { refreshPrices, _setFetchClosesForTests } from "./marketDataService.js";
import { getPortfolioSeries, getAllocation } from "./portfolioService.js";
import type { EngineContext } from "./context.js";

const NOW = "2026-07-01T08:00:00.000Z";
const TODAY = "2026-07-01";

function ctx(): EngineContext {
  return {
    lens: "combined",
    month: "2026-07",
    range: { start: "2026-07-01", end: "2026-07-31" },
    persons: [],
    personNames: new Map(),
    today: TODAY,
  };
}

beforeAll(() => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  _setDbForTests(db);
  db.prepare(`INSERT INTO persons (person_id, display_name, created_at) VALUES ('nick', 'Nick', ?), ('shanthi', 'Shanthi', ?)`).run(NOW, NOW);

  db.prepare(`INSERT INTO items (item_id, institution_name, linked_at) VALUES ('item-1', 'WS', ?)`).run(NOW);
  db.prepare(
    `INSERT INTO accounts (account_id, item_id, name, type, person_id, registered_type, current_balance, updated_at)
     VALUES ('acc-tfsa', 'item-1', 'TFSA', 'investment', 'nick', 'TFSA', 2450, ?)`,
  ).run(NOW);

  // User enters: 100 XEQT bought June 26, 500 cash, and a US stock.
  savePosition({ accountId: "acc-tfsa", symbol: "XEQT.TO", name: "iShares All-Equity", assetType: "etf", quantity: 100, bookCost: 1500, effectiveDate: "2026-06-26" }, TODAY);
  savePosition({ accountId: "acc-tfsa", symbol: "AAPL", name: "Apple", assetType: "stock", quantity: 1, effectiveDate: "2026-06-26" }, TODAY);
  savePosition({ accountId: "acc-tfsa", name: "Cash", assetType: "cash", quantity: 1, manualValue: 500, effectiveDate: "2026-06-26" }, TODAY);

  upsertPrices([
    { security_id: "XEQT.TO", date: "2026-06-26", close_price: 16.0, currency: "CAD" },
    { security_id: "XEQT.TO", date: "2026-06-29", close_price: 16.5, currency: "CAD" }, // weekend gap
    { security_id: "XEQT.TO", date: "2026-07-01", close_price: 17.0, currency: "CAD" },
    { security_id: "AAPL", date: "2026-06-26", close_price: 100, currency: "USD" },
    { security_id: "AAPL", date: "2026-07-01", close_price: 110, currency: "USD" },
  ]);
  upsertFxRates([
    { date: "2026-06-26", baseCcy: "USD", quoteCcy: "CAD", rate: 1.35 },
    { date: "2026-07-01", baseCcy: "USD", quoteCcy: "CAD", rate: 1.4 },
  ]);
});

afterAll(() => {
  _setDbForTests(null);
  _setFetchClosesForTests(null);
});

describe("snapshot rebuild from positions", () => {
  it("prices daily with carry-forward, CAD conversion, and manual values", () => {
    const result = rebuildSnapshots("2026-06-26", TODAY);
    expect(result.snapshotRows).toBe(18); // 3 positions × 6 days

    const june27 = getDb()
      .prepare(`SELECT security_id, value FROM holdings_snapshots WHERE date = '2026-06-27' ORDER BY security_id`)
      .all() as { security_id: string; value: number }[];
    // Saturday: XEQT carries Friday's 16.00 → 1600; AAPL 100 USD @1.35 → 135; cash 500.
    expect(june27.find((r) => r.security_id === "XEQT.TO")?.value).toBe(1600);
    expect(june27.find((r) => r.security_id === "AAPL")?.value).toBe(135);
    expect(june27.find((r) => r.security_id.startsWith("pos:"))?.value).toBe(500);

    const series = getPortfolioSeries(ctx(), 30, false).series;
    const last = series[series.length - 1]!;
    // Today: 100×17 + 1×110×1.40 + 500 = 1700 + 154 + 500 = 2354.
    expect(last.value).toBe(2354);
  });

  it("versioned edits change history from their effective date", () => {
    const view = getPositionsView(ctx());
    const xeqt = view[0]!.positions.find((p) => p.symbol === "XEQT.TO")!;
    // Sold half on June 30.
    savePosition({ positionId: xeqt.position_id, accountId: "acc-tfsa", symbol: "XEQT.TO", name: "iShares All-Equity", assetType: "etf", quantity: 50, bookCost: 750, effectiveDate: "2026-06-30" }, TODAY);
    rebuildSnapshots("2026-06-26", TODAY);

    const before = getDb().prepare(`SELECT SUM(value) AS v FROM holdings_snapshots WHERE date = '2026-06-29' AND security_id = 'XEQT.TO'`).get() as { v: number };
    const after = getDb().prepare(`SELECT SUM(value) AS v FROM holdings_snapshots WHERE date = '2026-06-30' AND security_id = 'XEQT.TO'`).get() as { v: number };
    expect(before.v).toBe(1650); // 100 × 16.50
    expect(after.v).toBe(825); // 50 × 16.50 (carry-forward)
  });
});

describe("reconciliation", () => {
  it("computes drift vs the synced account balance", () => {
    const view = getPositionsView(ctx());
    const tfsa = view[0]!;
    // Positions now: 50 XEQT ×17 = 850, AAPL 154, cash 500 → 1504 vs reported 2450.
    expect(tfsa.computedTotal).toBe(1504);
    expect(tfsa.drift).toBe(1504 - 2450);
  });
});

describe("allocation from manual positions", () => {
  it("classifies by asset type", () => {
    const slices = getAllocation(ctx());
    const byClass = new Map(slices.map((s) => [s.class, s.value]));
    expect(byClass.get("equity")).toBe(850 + 154); // etf + stock
    expect(byClass.get("cash")).toBe(500);
  });
});

describe("refreshPrices", () => {
  it("fetches only the missing tail per symbol", async () => {
    const calls: { symbol: string; rangeDays: number }[] = [];
    _setFetchClosesForTests(async (symbol, rangeDays) => {
      calls.push({ symbol, rangeDays });
      return [
        { date: "2026-07-01", close: 17.5, currency: "CAD" },
        { date: "2026-07-02", close: 17.8, currency: "CAD" },
      ];
    });
    const result = await refreshPrices("2026-07-02");
    expect(result.errors).toEqual([]);
    expect(calls.map((c) => c.symbol).sort()).toEqual(["AAPL", "XEQT.TO"]);
    expect(calls.every((c) => c.rangeDays < 30)).toBe(true); // tail, not full history
    // Only dates newer than the stored latest were inserted.
    const latest = getDb().prepare(`SELECT MAX(date) AS d FROM security_prices WHERE security_id = 'XEQT.TO'`).get() as { d: string };
    expect(latest.d).toBe("2026-07-02");
  });

  it("degrades per-symbol on fetch errors", async () => {
    _setFetchClosesForTests(async (symbol) => {
      if (symbol === "AAPL") throw new Error("network down");
      return [{ date: "2026-07-03", close: 18, currency: "CAD" }];
    });
    const result = await refreshPrices("2026-07-03");
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]?.symbol).toBe("AAPL");
    expect(result.pricesFetched).toBeGreaterThan(0); // XEQT still landed
  });
});
