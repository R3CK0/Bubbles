/**
 * Integration: migrations → fixture rows → repositories → services.
 * Exercises the same path the HTTP routes use, minus Express.
 */
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _setDbForTests, getDb } from "../db/db.js";
import { runMigrations } from "../db/migrator.js";
import { upsertCategory, upsertRule, createBudgetVersion, uncategorizedCount } from "../db/repositories/budgeting.js";
import { categorizeRange, detectTransfers, getInbox, categorizeManually } from "./categorizationService.js";
import { getCashflowSummary, getSankey, getFluxMatrix } from "./cashflowService.js";
import { getBudgetView } from "./budgetService.js";
import type { EngineContext } from "./context.js";

const NOW = "2026-06-15T12:00:00.000Z";

function ctx(over: Partial<EngineContext> = {}): EngineContext {
  return {
    lens: "combined",
    month: "2026-06",
    range: { start: "2026-06-01", end: "2026-06-30" },
    persons: [],
    personNames: new Map([
      ["nick", "Nick"],
      ["shanthi", "Shanthi"],
    ]),
    today: "2026-06-15",
    ...over,
  };
}

function insertTx(id: string, accountId: string, amount: number, date: string, extra: Record<string, unknown> = {}): void {
  getDb()
    .prepare(
      `INSERT INTO transactions (transaction_id, account_id, item_id, amount, iso_currency_code, date, merchant_name, personal_finance_category_primary, personal_finance_category_detailed, pending, removed, updated_at, reimbursed_by)
       VALUES (@id, @accountId, 'item-1', @amount, 'CAD', @date, @merchant, @plaidPrimary, @plaidDetailed, 0, 0, @now, @reimbursedBy)`,
    )
    .run({
      id,
      accountId,
      amount,
      date,
      merchant: extra.merchant ?? null,
      plaidPrimary: extra.plaidPrimary ?? null,
      plaidDetailed: extra.plaidDetailed ?? null,
      reimbursedBy: extra.reimbursedBy ?? null,
      now: NOW,
    });
}

beforeAll(() => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  _setDbForTests(db);
  db.prepare(`INSERT INTO persons (person_id, display_name, created_at) VALUES ('nick', 'Nick', ?), ('shanthi', 'Shanthi', ?)`).run(NOW, NOW);

  db.prepare(`INSERT INTO items (item_id, institution_name, linked_at) VALUES ('item-1', 'Test Bank', @now)`).run({ now: NOW });
  const insertAccount = db.prepare(
    `INSERT INTO accounts (account_id, item_id, name, type, person_id, updated_at) VALUES (?, 'item-1', ?, ?, ?, ?)`,
  );
  insertAccount.run("acc-chq", "Chequing", "depository", "nick", NOW);
  insertAccount.run("acc-sav", "Vacation savings", "depository", null, NOW);

  // Category tree + rules (mirrors a slice of the seed).
  const cats: [string, string | null, string, "income" | "expense" | "savings"][] = [
    ["income", null, "Income", "income"],
    ["income-salary", "income", "Salary", "income"],
    ["essentials", null, "Essentials", "expense"],
    ["essentials-groceries", "essentials", "Groceries", "expense"],
    ["essentials-restaurants", "essentials", "Restaurants", "expense"],
  ];
  cats.forEach(([id, parent, name, kind], i) =>
    upsertCategory({ category_id: id, parent_id: parent, name, kind, sort_order: i, archived: 0 }),
  );
  upsertRule({ rule_id: "r-groc", priority: 50, merchant_pattern: null, payee_pattern: null, plaid_category: "FOOD_AND_DRINK_GROCERIES", account_id: null, amount_min: null, amount_max: null, category_id: "essentials-groceries", goal_id: null, goal_line_id: null, source: "manual", locked_at: null, active: 1, created_at: NOW });
  upsertRule({ rule_id: "r-income", priority: 90, merchant_pattern: null, payee_pattern: null, plaid_category: "INCOME", account_id: null, amount_min: null, amount_max: null, category_id: "income-salary", goal_id: null, goal_line_id: null, source: "manual", locked_at: null, active: 1, created_at: NOW });

  createBudgetVersion(
    "test budget",
    "2026-06-01",
    null,
    [
      { category_id: "essentials-groceries", person_id: "nick", monthly_amount: 1000 },
      { category_id: "essentials-restaurants", person_id: null, monthly_amount: 600 },
    ],
    NOW,
  );

  insertTx("t-salary", "acc-chq", -7000, "2026-06-01", { plaidPrimary: "INCOME" });
  insertTx("t-groc-1", "acc-chq", 250.25, "2026-06-05", { merchant: "Metro", plaidDetailed: "FOOD_AND_DRINK_GROCERIES" });
  insertTx("t-groc-2", "acc-chq", 149.75, "2026-06-12", { merchant: "Costco", plaidDetailed: "FOOD_AND_DRINK_GROCERIES" });
  insertTx("t-resto", "acc-chq", 85, "2026-06-10", { merchant: "Sushi Yama" });
  insertTx("t-xfer-out", "acc-chq", 833, "2026-06-10");
  insertTx("t-xfer-in", "acc-sav", -833, "2026-06-11");
  insertTx("t-work", "acc-chq", 321.93, "2026-06-08", { merchant: "Anthropic", reimbursedBy: "work" });
});

afterAll(() => _setDbForTests(null));

describe("categorization pipeline", () => {
  it("applies rules, detects transfers, leaves the rest for the inbox", () => {
    const applied = categorizeRange({ start: "2026-06-01", end: "2026-06-30" });
    expect(applied).toBe(3); // salary + two groceries

    const pairs = detectTransfers({ start: "2026-06-01", end: "2026-06-30" });
    expect(pairs).toBe(1);

    // resto stays for the inbox; t-work is reimbursed → already handled,
    // so it never shows up as categorization work
    expect(uncategorizedCount()).toBe(1);
    const inbox = getInbox();
    expect(inbox.cards.map((c) => c.transaction.transactionId).sort()).toEqual(["t-resto"]);

    expect(categorizeManually("t-resto", "essentials-restaurants")).toBe(true);
    // rule re-run must not clobber the manual choice
    categorizeRange({ start: "2026-06-01", end: "2026-06-30" });
    expect(uncategorizedCount()).toBe(0);
  });
});

describe("cashflow service", () => {
  it("computes the month summary with transfers/reimbursed excluded", () => {
    const s = getCashflowSummary(ctx());
    expect(s.income).toBe(7000);
    expect(s.spend).toBe(485); // 250.25 + 149.75 + 85
    expect(s.net).toBe(6515);
  });

  it("builds a balanced sankey", () => {
    const g = getSankey(ctx());
    const into = g.links.filter((l) => l.target === "Household").reduce((s, l) => s + l.value, 0);
    const out = g.links.filter((l) => l.source === "Household").reduce((s, l) => s + l.value, 0);
    expect(into).toBeCloseTo(out, 2);
    expect(g.links.find((l) => l.source === "Essentials" && l.target === "Groceries")?.value).toBe(400);
  });

  it("flux matrix centers the window on the viewed month", () => {
    const m = getFluxMatrix(ctx(), 3);
    // 1 back, the viewed month, 1 ahead — future months carry no cells
    expect(m.months).toEqual(["2026-05", "2026-06", "2026-07"]);
    expect(m.cells.find((c) => c.month === "2026-06" && c.categoryId === "essentials")?.value).toBe(485);
    expect(m.cells.some((c) => c.month === "2026-07")).toBe(false);
  });
});

describe("budget service", () => {
  it("budget vs actual with mid-month pace", () => {
    const view = getBudgetView(ctx());
    expect(view.version?.name).toBe("test budget");
    expect(view.dayFraction).toBeCloseTo(15 / 30, 4);

    const groceries = view.rows.find((r) => r.categoryId === "essentials-groceries")!;
    expect(groceries.budget).toBe(1000);
    expect(groceries.actual).toBe(400);
    expect(groceries.pace).toBeCloseTo(0.8, 2); // under pace at mid-month

    const resto = view.rows.find((r) => r.categoryId === "essentials-restaurants")!;
    expect(resto.budget).toBe(600);
    expect(resto.actual).toBe(85);
  });

  it("person lens narrows both budget and actuals", () => {
    const view = getBudgetView(ctx({ lens: "shanthi" }));
    const groceries = view.rows.find((r) => r.categoryId === "essentials-groceries");
    expect(groceries?.budget ?? 0).toBe(0); // nick's line drops out
    const resto = view.rows.find((r) => r.categoryId === "essentials-restaurants")!;
    expect(resto.budget).toBe(600); // joint line stays
  });
});
