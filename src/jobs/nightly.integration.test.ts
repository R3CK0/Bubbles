/**
 * Integration: the nightly pipeline over an in-memory DB — matching, price
 * creep, snapshots, sync_runs bracketing, and idempotent re-runs.
 */
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _setDbForTests, getDb } from "../db/db.js";
import { runMigrations } from "../db/migrator.js";
import { upsertRecurring } from "../db/repositories/recurring.js";
import { openAlerts, lastSuccessfulRun } from "../db/repositories/ops.js";
import { runNightly } from "./nightly.js";
import { getBillsCalendar } from "../engine/recurringService.js";
import { getPayoffPlan } from "../engine/debtService.js";
import type { EngineContext } from "../engine/context.js";

const NOW = "2026-07-01T08:00:00.000Z";

function ctx(): EngineContext {
  return {
    lens: "combined",
    month: "2026-07",
    range: { start: "2026-07-01", end: "2026-07-31" },
    persons: [],
    personNames: new Map(),
    today: "2026-07-01",
  };
}

beforeAll(() => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  _setDbForTests(db);
  db.prepare(`INSERT INTO persons (person_id, display_name, created_at) VALUES ('nick', 'Nick', ?), ('shanthi', 'Shanthi', ?)`).run(NOW, NOW);

  db.prepare(`INSERT INTO items (item_id, institution_name, linked_at) VALUES ('item-1', 'Bank', ?)`).run(NOW);
  db.prepare(
    `INSERT INTO accounts (account_id, item_id, name, type, current_balance, iso_currency_code, updated_at)
     VALUES ('acc-chq', 'item-1', 'Chequing', 'depository', 4000, 'CAD', ?)`,
  ).run(NOW);

  upsertRecurring({
    rp_id: "rp-netflix",
    name: "Netflix",
    category_id: null,
    person_id: null,
    account_id: null,
    expected_amount: 27.59,
    amount_tolerance: 0.05,
    currency: "CAD",
    frequency: "monthly",
    interval_days: null,
    anchor_date: "2026-06-28",
    next_due_date: "2026-06-28",
    end_date: null,
    autopay: 1,
    reimbursed_by: null,
    debt_id: null,
    source: "manual",
    status: "active",
    created_at: NOW,
  });

  // A price-crept Netflix charge near the due date.
  getDb()
    .prepare(
      `INSERT INTO transactions (transaction_id, account_id, item_id, amount, date, merchant_name, pending, removed, updated_at)
       VALUES ('t-netflix', 'acc-chq', 'item-1', 29.99, '2026-06-29', 'NETFLIX #123', 0, 0, ?)`,
    )
    .run(NOW);

  getDb()
    .prepare(
      `INSERT INTO debts (debt_id, person_id, name, kind, current_balance, apr, min_payment, status, created_at)
       VALUES ('d-cc', 'nick', 'Card', 'credit_card', 3000, 21, 60, 'active', ?)`,
    )
    .run(NOW);
});

afterAll(() => _setDbForTests(null));

describe("nightly pipeline", () => {
  it("runs all steps, matches the charge, flags creep, snapshots, records the run", async () => {
    const { status, stats } = await runNightly(null);
    expect(status).toBe("success");
    expect((stats.sync as { skipped: string }).skipped).toBe("vault locked");
    expect((stats.fx as { skipped: boolean }).skipped).toBe(true); // no USD accounts
    expect((stats.snapshots as { accountsSnapshotted: number }).accountsSnapshotted).toBe(1);
    expect((stats.recurring as { matched: number }).matched).toBe(1);
    expect((stats.recurring as { creepAlerts: number }).creepAlerts).toBe(1);

    const linked = getDb()
      .prepare(`SELECT recurring_payment_id FROM transactions WHERE transaction_id = 't-netflix'`)
      .get() as { recurring_payment_id: string };
    expect(linked.recurring_payment_id).toBe("rp-netflix");

    const nextDue = getDb()
      .prepare(`SELECT next_due_date FROM recurring_payments WHERE rp_id = 'rp-netflix'`)
      .get() as { next_due_date: string };
    expect(nextDue.next_due_date).toBe("2026-07-28");

    expect(openAlerts().filter((a) => a.alert_type === "price_creep").length).toBe(1);
    expect(lastSuccessfulRun()?.status).toBe("success");
  });

  it("re-runs idempotently: no double snapshots, matches, or alerts", async () => {
    const { status, stats } = await runNightly(null);
    expect(status).toBe("success");
    expect((stats.recurring as { matched: number }).matched).toBe(0); // already linked
    expect(openAlerts().filter((a) => a.alert_type === "price_creep").length).toBe(1); // deduped
    const snapshots = getDb().prepare(`SELECT COUNT(*) AS n FROM account_snapshots`).get() as { n: number };
    expect(snapshots.n).toBe(1); // INSERT OR REPLACE, same day
  });
});

describe("bills calendar", () => {
  it("expands dues, projects the balance, finds no low windows at this buffer", () => {
    const cal = getBillsCalendar(ctx());
    expect(cal.days.find((d) => d.date === "2026-07-28")?.items[0]?.name).toBe("Netflix");
    expect(cal.projection.length).toBe(31);
    expect(cal.startBalance).toBe(4000);
    const last = cal.projection[cal.projection.length - 1]!;
    expect(last.value).toBe(4000 - 27.59);
    expect(cal.lowWindows).toEqual([]);
  });
});

describe("debt payoff over repo data", () => {
  it("produces a plan from stored debts", () => {
    const plan = getPayoffPlan(ctx(), "avalanche", 440);
    // budget = min 60 + extra 440 = 500; month 1: 3000 + 52.50 interest − 500 = 2552.50
    expect(plan.perDebt[0]?.balances[0]).toBe(2552.5);
    expect(plan.debtFreeMonth).not.toBeNull();
  });
});
