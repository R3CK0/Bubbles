/**
 * Integration: migrations → fixture rows → repositories → services.
 * Exercises the same path the HTTP routes use, minus Express.
 */
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _setDbForTests, getDb } from "../db/db.js";
import { runMigrations } from "../db/migrator.js";
import { upsertCategory, upsertRule, createBudgetVersion, uncategorizedCount, getFlowTx } from "../db/repositories/budgeting.js";
import { getRecurring } from "../db/repositories/recurring.js";
import {
  categorizeRange,
  detectTransfers,
  getInbox,
  categorizeManually,
  markTransferPending,
  matchPendingTransfers,
  sweepCardPayments,
  unmarkTransfer,
} from "./categorizationService.js";
import { flagRecurringFromTransaction, matchNewTransactions } from "./recurringService.js";
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

describe("user-marked transfers", () => {
  it("marks a leg pending, then validates when the counterpart lands", () => {
    insertTx("t-mark-out", "acc-chq", 500, "2026-07-02", { merchant: "Transfer to savings" });
    expect(markTransferPending("t-mark-out")).toEqual({ marked: true, matched: false });

    // pending: excluded from flows already, but no group yet
    const pendingLeg = getFlowTx("t-mark-out")!;
    expect(pendingLeg.isTransfer).toBe(true);
    expect(pendingLeg.transferGroupId).toBeNull();

    // the counterpart syncs three days later → the sweep validates the pair
    insertTx("t-mark-in", "acc-sav", -500, "2026-07-05");
    expect(matchPendingTransfers("2026-07-05").matched).toBe(1);
    const out = getFlowTx("t-mark-out")!;
    const inn = getFlowTx("t-mark-in")!;
    expect(out.transferGroupId).not.toBeNull();
    expect(inn.transferGroupId).toBe(out.transferGroupId);

    // unmarking a validated pair releases BOTH legs
    expect(unmarkTransfer("t-mark-out")).toBe(2);
    expect(getFlowTx("t-mark-in")!.isTransfer).toBe(false);
  });

  it("flags a stale mark once the window closes, without dropping the mark", () => {
    insertTx("t-stale", "acc-chq", 77.77, "2026-07-01", { merchant: "E-transfer" });
    markTransferPending("t-stale");
    expect(matchPendingTransfers("2026-07-05").stale).toBe(0); // still inside the window
    expect(matchPendingTransfers("2026-07-20").stale).toBe(1); // window closed, no counterpart
    expect(getFlowTx("t-stale")!.isTransfer).toBe(true); // stays excluded until the user unmarks
    expect(unmarkTransfer("t-stale")).toBe(1);
  });
});

describe("credit-card & loan payments", () => {
  beforeAll(() => {
    getDb()
      .prepare(
        `INSERT INTO accounts (account_id, item_id, name, type, person_id, updated_at)
         VALUES ('acc-cc', 'item-1', 'Visa', 'credit', 'nick', ?)`,
      )
      .run(NOW);
  });

  it("still amount-pairs a card payment with its funding withdrawal", () => {
    insertTx("t-cc-pay", "acc-cc", -1200, "2026-10-12", { plaidPrimary: "LOAN_PAYMENTS", plaidDetailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" });
    insertTx("t-cc-fund", "acc-chq", 1200, "2026-10-10", { merchant: "Payment - Visa" });
    detectTransfers({ start: "2026-10-01", end: "2026-10-31" });
    const pay = getFlowTx("t-cc-pay")!;
    const fund = getFlowTx("t-cc-fund")!;
    expect(pay.isTransfer).toBe(true);
    expect(fund.isTransfer).toBe(true);
    expect(pay.transferGroupId).toBe(fund.transferGroupId);
  });

  it("flags an unmatched card payment as pending so it never reads as income", () => {
    insertTx("t-cc-lonely", "acc-cc", -300, "2026-11-05", { plaidPrimary: "LOAN_PAYMENTS" });
    const range = { start: "2026-11-01", end: "2026-11-30" };
    expect(detectTransfers(range)).toBe(0); // no funding leg to amount-pair
    expect(sweepCardPayments(range)).toBe(1);
    const leg = getFlowTx("t-cc-lonely")!;
    expect(leg.isTransfer).toBe(true);
    expect(leg.transferGroupId).toBeNull();
  });

  it("leaves a card refund alone — an inflow with no payment signal", () => {
    insertTx("t-cc-refund", "acc-cc", -60, "2026-12-05", { merchant: "Amazon refund", plaidPrimary: "GENERAL_MERCHANDISE" });
    expect(sweepCardPayments({ start: "2026-12-01", end: "2026-12-31" })).toBe(0);
    expect(getFlowTx("t-cc-refund")!.isTransfer).toBe(false);
  });

  it("reconciles a pending card payment with a later funding leg in the window", () => {
    insertTx("t-loan-pay", "acc-cc", -800, "2027-01-10", { plaidPrimary: "LOAN_PAYMENTS" });
    sweepCardPayments({ start: "2027-01-01", end: "2027-01-31" });
    expect(getFlowTx("t-loan-pay")!.transferGroupId).toBeNull(); // pending until funded
    insertTx("t-loan-fund", "acc-chq", 800, "2027-01-08", { merchant: "Bill payment" });
    expect(matchPendingTransfers("2027-01-12").matched).toBe(1);
    const pay = getFlowTx("t-loan-pay")!;
    const fund = getFlowTx("t-loan-fund")!;
    expect(pay.transferGroupId).not.toBeNull();
    expect(fund.transferGroupId).toBe(pay.transferGroupId);
  });
});

describe("recurring flagged from the inbox", () => {
  it("creates a pending bill that confirms when the charge comes back", () => {
    insertTx("t-gym-1", "acc-chq", 45.99, "2026-07-03", { merchant: "EconoFitness" });
    const flag = flagRecurringFromTransaction("t-gym-1", { frequency: "monthly" }, "2026-07-03")!;
    expect(flag.alreadyTracked).toBe(false);
    expect(flag.recurring.status).toBe("proposed");
    expect(flag.recurring.source).toBe("manual");
    expect(flag.recurring.expected_amount).toBe(45.99);
    expect(flag.recurring.next_due_date).toBe("2026-08-03");

    // categorizing the flagged charge fills the pending bill's empty category
    categorizeManually("t-gym-1", "essentials-restaurants");
    expect(getRecurring(flag.recurring.rp_id)!.category_id).toBe("essentials-restaurants");

    // next month's charge lands near the due date → matched AND confirmed
    insertTx("t-gym-2", "acc-chq", 45.99, "2026-08-02", { merchant: "EconoFitness" });
    const res = matchNewTransactions({ start: "2026-08-01", end: "2026-08-31" }, "2026-08-02T12:00:00.000Z");
    expect(res.confirmed).toBe(1);
    expect(getRecurring(flag.recurring.rp_id)!.status).toBe("active");
  });

  it("re-flagging the same merchant links to the existing bill instead of duplicating", () => {
    insertTx("t-gym-3", "acc-chq", 45.99, "2026-09-03", { merchant: "EconoFitness" });
    const again = flagRecurringFromTransaction("t-gym-3", { frequency: "monthly" }, "2026-09-03")!;
    expect(again.alreadyTracked).toBe(true);
    expect(again.recurring.name).toBe("EconoFitness");
  });
});
