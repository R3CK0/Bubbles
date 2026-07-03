/**
 * engine/taxService.ts — Taxes page: estimates, optimizer, couple strategies,
 * room tracking, contribution detection. Sole owner of the tax repository.
 */
import {
  bracketGlasses,
  enumerateStrategies,
  estimateTax,
  householdEstimate,
  optimizeContributions,
  roundCents,
  monthOf,
  type BracketFill,
  type CoupleStrategy,
  type OptimizerResult,
  type TaxInput,
  type TaxResult,
  type TaxTables,
} from "../analytics/index.js";
import { FEDERAL_SCOPE_EXCLUSIONS } from "../analytics/tax/federal.js";
import { QUEBEC_SCOPE_EXCLUSIONS } from "../analytics/tax/quebec.js";
import type { EngineContext } from "./context.js";
import { getDb } from "../db/db.js";
import {
  contributionSum,
  contributionsFor,
  getTaxProfile,
  latestTaxTables,
  recordContribution,
  roomFor,
  saveEstimate,
  setRoom,
  upsertTaxProfile,
  type RegisteredRoomRow,
  type TaxProfileRow,
} from "../db/repositories/tax.js";
import { listGoals } from "../db/repositories/planning.js";
import { getBuildingsPnl } from "./portfolioService.js";
import { invTxRange } from "../db/repositories/investments.js";
import { approveSolveAsPlan, budgetedFreeCashFlow } from "./planningService.js";

function requireTables(year: number): TaxTables {
  const tables = latestTaxTables(year);
  if (!tables) {
    throw Object.assign(new Error(`no tax tables for ${year} — INSERT the year's payloads (see db/seeds/taxTables2026.ts)`), { status: 404 });
  }
  return tables;
}

interface OtherIncome {
  interest?: number;
  eligibleDividends?: number;
  capitalGains?: number;
  rentalNet?: number;
  donations?: number;
  medicalExpenses?: number;
}

/** Per-person TaxInput assembled from profile + platform data. */
export function assembleTaxInputs(ctx: EngineContext, year: number): TaxInput[] {
  const buildings = getBuildingsPnl(ctx, 12);
  const rentalNetYtd = roundCents(
    buildings.netByMonth.filter((m) => m.month.startsWith(String(year))).reduce((s, m) => s + m.value, 0),
  );
  const buildingsOwner = buildings.asset?.person_id ?? null;

  // Dividends/interest observed in registered accounts don't count; only
  // non-registered. Filter by account registered_type.
  const nonRegDivs = invTxRange({ start: `${year}-01-01`, end: `${year}-12-31` }, ["dividend", "interest"]).filter((t) => {
    const reg = getDb()
      .prepare(`SELECT registered_type FROM accounts WHERE account_id = ?`)
      .get(t.account_id) as { registered_type: string | null } | undefined;
    return !reg?.registered_type || reg.registered_type === "NONREG";
  });

  return ctx.persons.map((p) => {
    const profile = getTaxProfile(p.person_id, year);
    const other: OtherIncome = profile?.other_income_json ? JSON.parse(profile.other_income_json) : {};
    const divs = roundCents(
      nonRegDivs
        .filter((t) => {
          const owner = getDb().prepare(`SELECT person_id FROM accounts WHERE account_id = ?`).get(t.account_id) as
            | { person_id: string | null }
            | undefined;
          return owner?.person_id === p.person_id || owner?.person_id === null;
        })
        .reduce((s, t) => s + Math.abs(t.amount), 0),
    );

    const deducted = contributionsFor(p.person_id, year).filter(
      (c) => (c.deduction_year ?? year) === year && (c.account_type === "RRSP" || c.account_type === "RRSP_SPOUSAL"),
    );
    const fhsaContribs = contributionSum(p.person_id, "FHSA", year);

    return {
      personId: p.person_id,
      taxYear: year,
      employmentIncome: profile?.employment_income ?? 0,
      // observed Buildings P&L + the profile's manual figure (onboarding /
      // assumptions panel — zero it once Buildings tracking takes over)
      rentalNet: roundCents((buildingsOwner === p.person_id ? rentalNetYtd : 0) + (other.rentalNet ?? 0)),
      interestIncome: other.interest ?? 0,
      eligibleDividends: (other.eligibleDividends ?? 0) + divs,
      capitalGains: other.capitalGains ?? 0,
      rrspDeduction: roundCents(deducted.reduce((s, c) => s + c.amount, 0)),
      fhsaDeduction: fhsaContribs,
      donations: other.donations ?? 0,
      medicalExpenses: other.medicalExpenses ?? 0,
      withholdingPaid: profile?.withholding_paid ?? 0,
    };
  });
}

export interface TaxEstimateResponse {
  year: number;
  perPerson: (TaxResult & { glasses: BracketFill[] })[];
  household: ReturnType<typeof householdEstimate>;
  scopeExclusions: string[];
}

export function getEstimates(ctx: EngineContext, year: number): TaxEstimateResponse {
  const tables = requireTables(year);
  const inputs = assembleTaxInputs(ctx, year);
  const results = inputs.map((input) => ({
    ...estimateTax(input, tables),
    glasses: bracketGlasses(input, tables),
  }));
  const now = new Date().toISOString();
  for (let i = 0; i < results.length; i++) {
    saveEstimate({
      person_id: results[i]!.personId,
      scenario_id: null,
      tax_year: year,
      kind: "estimate",
      computed_at: now,
      inputs: inputs[i],
      results: results[i],
    });
  }
  return {
    year,
    perPerson: results,
    household: householdEstimate(results),
    scopeExclusions: [...FEDERAL_SCOPE_EXCLUSIONS, ...QUEBEC_SCOPE_EXCLUSIONS],
  };
}

// ---- room ----

export interface RoomView {
  personId: string;
  accountType: "FHSA" | "TFSA" | "RRSP";
  taxYear: number;
  room: number;
  contributed: number;
  remaining: number;
  asOf: string | null;
}

export function getRoom(ctx: EngineContext, year: number): RoomView[] {
  const out: RoomView[] = [];
  for (const p of ctx.persons) {
    const rows = roomFor(p.person_id, year);
    for (const type of ["FHSA", "TFSA", "RRSP"] as const) {
      const row = rows.find((r) => r.account_type === type);
      const contributed = contributionSum(p.person_id, type, year);
      out.push({
        personId: p.person_id,
        accountType: type,
        taxYear: year,
        room: row?.room_amount ?? 0,
        contributed: roundCents(contributed),
        remaining: roundCents(Math.max(0, (row?.room_amount ?? 0) - contributed)),
        asOf: row?.as_of ?? null,
      });
    }
  }
  return out;
}

export function updateRoom(rows: RegisteredRoomRow[]): void {
  for (const row of rows) setRoom(row);
}

export function updateProfile(row: TaxProfileRow): void {
  upsertTaxProfile(row);
}

export function getProfiles(ctx: EngineContext, year: number): TaxProfileRow[] {
  return ctx.persons
    .map((p) => getTaxProfile(p.person_id, year))
    .filter((p): p is TaxProfileRow => p !== undefined);
}

// ---- optimizer ----

export function runOptimizer(ctx: EngineContext, deployableCash: number, year: number): OptimizerResult {
  const tables = requireTables(year);
  const inputs = assembleTaxInputs(ctx, year);
  const room = getRoom(ctx, year);
  const monthsRemaining = 12 - Number(ctx.month.slice(5, 7)) + 1;
  const houseGoalActive = listGoals("active").some((g) => g.goal_type === "house");

  const result = optimizeContributions(
    {
      persons: inputs.map((input) => ({
        input,
        roomFhsa: room.find((r) => r.personId === input.personId && r.accountType === "FHSA")?.remaining ?? 0,
        roomRrsp: room.find((r) => r.personId === input.personId && r.accountType === "RRSP")?.remaining ?? 0,
        roomTfsa: room.find((r) => r.personId === input.personId && r.accountType === "TFSA")?.remaining ?? 0,
      })),
      deployableCash,
      houseGoalActive,
      monthsRemaining,
    },
    tables,
  );
  saveEstimate({
    person_id: null,
    scenario_id: null,
    tax_year: year,
    kind: "optimization",
    computed_at: new Date().toISOString(),
    inputs: { deployableCash, monthsRemaining, houseGoalActive },
    results: result,
  });
  return result;
}

/** Accept: optimizer schedule → contribution targets → a fresh approved plan. */
export function acceptOptimization(ctx: EngineContext, deployableCash: number, year: number, planName: string) {
  const tables = requireTables(year);
  const result = runOptimizer(ctx, deployableCash, year);
  const inputs = assembleTaxInputs(ctx, year);
  const contributionTargets = result.monthlySchedule.map((s) => {
    const input = inputs.find((i) => i.personId === s.personId)!;
    const marginal = estimateTax(input, tables).marginalRate;
    const equivalentReturn = s.type === "tfsa" ? 5 : Math.round(marginal * 100) + 5;
    return {
      key: `${s.personId}:${s.type}`,
      personId: s.personId,
      type: s.type,
      monthlyCap: s.monthly,
      equivalentReturn,
      reason: `${s.type.toUpperCase()} per optimizer (${Math.round(marginal * 100)}% marginal)`,
    };
  });
  // The user asserted `deployableCash` exists — if the budget-derived free
  // cash flow is lower (or absent), trust the assertion so the accepted plan
  // actually carries the contribution lines instead of silently dropping them.
  const monthlyTotal = roundCents(contributionTargets.reduce((s, t) => s + t.monthlyCap, 0));
  const freeCashFlowMonthly = Math.max(budgetedFreeCashFlow(ctx.month), monthlyTotal);
  return approveSolveAsPlan(ctx, planName, { contributionTargets, freeCashFlowMonthly });
}

// ---- couple strategies ----

export function getStrategies(ctx: EngineContext, year: number): CoupleStrategy[] {
  const tables = requireTables(year);
  const inputs = assembleTaxInputs(ctx, year);
  if (inputs.length < 2) return [];
  const [a, b] = inputs as [TaxInput, TaxInput];
  const room = getRoom(ctx, year);
  const plannedRrsp = roundCents(
    room.filter((r) => r.accountType === "RRSP").reduce((s, r) => s + Math.min(r.remaining, 6000), 0),
  );
  return enumerateStrategies(
    {
      a,
      b,
      roomRrspA: room.find((r) => r.personId === a.personId && r.accountType === "RRSP")?.remaining ?? 0,
      roomRrspB: room.find((r) => r.personId === b.personId && r.accountType === "RRSP")?.remaining ?? 0,
      plannedRrsp,
    },
    tables,
  );
}

// ---- contribution detection (nightly) ----

/**
 * Transfers INTO registered accounts (and investment-transaction
 * contributions) become registered_contributions rows. Idempotent via
 * deterministic contrib ids. RRSP first-60-days: Jan/Feb contributions may be
 * deducted against the prior year — recorded with tax_year = calendar year
 * and deduction_year = NULL (banked) for the user/optimizer to assign.
 */
export function detectContributions(range: { start: string; end: string }): number {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT t.transaction_id, t.account_id, t.date, t.amount, a.person_id, a.registered_type
       FROM transactions t JOIN accounts a ON a.account_id = t.account_id
       WHERE a.registered_type IN ('FHSA','TFSA','RRSP') AND t.removed = 0
         AND t.amount < 0 AND t.date >= ? AND t.date <= ?`,
    )
    .all(range.start, range.end) as {
    transaction_id: string;
    account_id: string;
    date: string;
    amount: number;
    person_id: string | null;
    registered_type: "FHSA" | "TFSA" | "RRSP";
  }[];

  let recorded = 0;
  for (const r of rows) {
    if (!r.person_id) continue;
    const created = recordContribution({
      contrib_id: `tx-${r.transaction_id}`,
      person_id: r.person_id,
      account_type: r.registered_type,
      account_id: r.account_id,
      date: r.date,
      amount: Math.abs(r.amount),
      transaction_id: r.transaction_id,
      tax_year: Number(monthOf(r.date).slice(0, 4)),
      deduction_year: r.registered_type === "TFSA" ? null : Number(r.date.slice(0, 4)),
      contributor_person_id: r.person_id,
    });
    if (created) recorded++;
  }

  const invRows = invTxRange(range, ["contribution"]);
  for (const r of invRows) {
    const meta = db
      .prepare(`SELECT person_id, registered_type FROM accounts WHERE account_id = ?`)
      .get(r.account_id) as { person_id: string | null; registered_type: string | null } | undefined;
    if (!meta?.person_id || !meta.registered_type || meta.registered_type === "NONREG") continue;
    const created = recordContribution({
      contrib_id: `inv-${r.inv_tx_id}`,
      person_id: meta.person_id,
      account_type: meta.registered_type as "FHSA" | "TFSA" | "RRSP",
      account_id: r.account_id,
      date: r.date,
      amount: Math.abs(r.amount),
      transaction_id: null,
      tax_year: Number(r.date.slice(0, 4)),
      deduction_year: meta.registered_type === "TFSA" ? null : Number(r.date.slice(0, 4)),
      contributor_person_id: meta.person_id,
    });
    if (created) recorded++;
  }
  return recorded;
}
