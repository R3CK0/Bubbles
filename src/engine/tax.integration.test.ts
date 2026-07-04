/**
 * Integration: tax service end-to-end — profiles + room + contribution
 * detection → estimates → optimizer → accepted plan; alerts sweep; review deck.
 */
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _setDbForTests, getDb } from "../db/db.js";
import { runMigrations } from "../db/migrator.js";
import { _resetTaxSeedForTests } from "../db/repositories/tax.js";
import { listPersons } from "../db/repository.js";
import {
  assembleTaxInputs,
  detectContributions,
  getEstimates,
  getRoom,
  getStrategies,
  runOptimizer,
  acceptOptimization,
  updateProfile,
  updateRoom,
} from "./taxService.js";
import { evaluateAll } from "./alertsService.js";
import { getOpenAlerts } from "./alertsService.js";
import { getReviewDeck } from "./reportService.js";
import { getActivePlan, createGoal } from "./planningService.js";
import type { EngineContext } from "./context.js";

const NOW = "2026-07-01T08:00:00.000Z";

function ctx(): EngineContext {
  const persons = listPersons();
  return {
    lens: "combined",
    month: "2026-07",
    range: { start: "2026-07-01", end: "2026-07-31" },
    persons,
    personNames: new Map(persons.map((p) => [p.person_id, p.display_name])),
    today: "2026-07-01",
  };
}

beforeAll(() => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  _setDbForTests(db);
  _resetTaxSeedForTests();
  db.prepare(`INSERT INTO persons (person_id, display_name, created_at) VALUES ('nick', 'Nick', ?), ('shanthi', 'Shanthi', ?)`).run(NOW, NOW);

  db.prepare(`INSERT INTO items (item_id, institution_name, linked_at) VALUES ('item-1', 'Bank', ?)`).run(NOW);
  db.prepare(
    `INSERT INTO accounts (account_id, item_id, name, type, person_id, registered_type, current_balance, updated_at)
     VALUES ('acc-fhsa', 'item-1', 'FHSA', 'investment', 'nick', 'FHSA', 5000, ?)`,
  ).run(NOW);
  // A deposit into the FHSA (Plaid sign: negative = money in).
  db.prepare(
    `INSERT INTO transactions (transaction_id, account_id, item_id, amount, date, pending, removed, updated_at)
     VALUES ('t-fhsa-dep', 'acc-fhsa', 'item-1', -2000, '2026-06-15', 0, 0, ?)`,
  ).run(NOW);

  updateProfile({
    person_id: "nick",
    tax_year: 2026,
    employment_income: 85_306,
    withholding_paid: 11_000,
    other_income_json: JSON.stringify({ donations: 300 }),
    carryforwards_json: null,
    weekly_take_home: null,
    updated_at: NOW,
  });
  // 48k keeps Shanthi in the lowest brackets → a real marginal-rate gap for
  // the couple-strategy assertions.
  updateProfile({
    person_id: "shanthi",
    tax_year: 2026,
    employment_income: 48_000,
    withholding_paid: 6_000,
    other_income_json: JSON.stringify({ donations: 360 }),
    carryforwards_json: null,
    weekly_take_home: null,
    updated_at: NOW,
  });
  updateRoom([
    { person_id: "nick", account_type: "FHSA", tax_year: 2026, room_amount: 8_000, as_of: "2026-07-01", source: "test" },
    { person_id: "nick", account_type: "RRSP", tax_year: 2026, room_amount: 20_000, as_of: "2026-07-01", source: "test" },
    { person_id: "nick", account_type: "TFSA", tax_year: 2026, room_amount: 30_000, as_of: "2026-07-01", source: "test" },
    { person_id: "shanthi", account_type: "FHSA", tax_year: 2026, room_amount: 8_000, as_of: "2026-07-01", source: "test" },
    { person_id: "shanthi", account_type: "RRSP", tax_year: 2026, room_amount: 12_000, as_of: "2026-07-01", source: "test" },
  ]);
});

afterAll(() => _setDbForTests(null));

describe("tax pipeline", () => {
  it("detects the FHSA contribution and decrements room", () => {
    expect(detectContributions({ start: "2026-06-01", end: "2026-07-01" })).toBe(1);
    expect(detectContributions({ start: "2026-06-01", end: "2026-07-01" })).toBe(0); // idempotent
    const room = getRoom(ctx(), 2026);
    const fhsa = room.find((r) => r.personId === "nick" && r.accountType === "FHSA")!;
    expect(fhsa.contributed).toBe(2000);
    expect(fhsa.remaining).toBe(6000);
  });

  it("estimates use profile + detected deductions", () => {
    const est = getEstimates(ctx(), 2026);
    const nick = est.perPerson.find((p) => p.personId === "nick")!;
    expect(nick.taxableIncome).toBeCloseTo(85_306 - 2_000, 0); // FHSA deducted
    expect(nick.balance).toBeGreaterThan(0); // under-withheld in fixture
    expect(est.household.totalIncomeTax).toBeGreaterThan(0);
    expect(est.scopeExclusions.length).toBeGreaterThan(0);
    const audit = getDb().prepare(`SELECT COUNT(*) AS n FROM tax_estimates WHERE kind='estimate'`).get() as { n: number };
    expect(audit.n).toBeGreaterThanOrEqual(2);
  });

  it("optimizer deploys into remaining room and accept writes an active plan", () => {
    createGoal({ goalType: "house", category: "saving", name: "House", targetAmount: 80_000, priority: 2 });
    const result = runOptimizer(ctx(), 12_000, 2026);
    expect(result.totalDeployed).toBe(12_000);
    const nick = result.allocations.find((a) => a.personId === "nick")!;
    expect(nick.fhsa).toBe(6_000); // fills remaining FHSA room first (house goal active)
    expect(result.totalTaxSaved).toBeGreaterThan(3_000);

    const { plan } = acceptOptimization(ctx(), 12_000, 2026, "Tax-optimized plan");
    expect(plan.status).toBe("active");
    const active = getActivePlan()!;
    expect(active.lines.some((l) => l.target_type === "fhsa")).toBe(true);
  });

  it("couple strategies are enumerated and priced", () => {
    const strategies = getStrategies(ctx(), 2026);
    expect(strategies.length).toBeGreaterThan(0);
    for (const s of strategies) expect(s.dollarImpact).toBeGreaterThan(0);
  });
});

describe("alerts + review", () => {
  it("alert sweep runs all rules without tables blowing up", () => {
    const stats = evaluateAll(ctx());
    expect(stats.rulesRun).toBe(7);
    // goal_off_track for the huge house goal with tiny free cash flow (no budget).
    expect(getOpenAlerts().some((a) => a.alert_type === "goal_off_track")).toBe(true);
  });

  it("review deck builds on demand and archives", () => {
    const deck = getReviewDeck("2026-06");
    expect(deck.slides.length).toBe(7);
    expect(deck.slides[0]?.kind).toBe("cashflow");
    const reports = getDb().prepare(`SELECT COUNT(*) AS n FROM reports`).get() as { n: number };
    expect(reports.n).toBe(1);
  });
});
