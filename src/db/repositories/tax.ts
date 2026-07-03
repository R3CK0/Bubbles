/**
 * db/repositories/tax.ts — data access for registered room, contributions,
 * tax profiles, tax tables, and the estimate audit trail.
 */
import { randomUUID } from "node:crypto";
import { getDb } from "../db.js";
import type { TaxTablePayload, TaxTables } from "../../analytics/tax/types.js";
import { TAX_TABLES_2026 } from "../seeds/taxTables2026.js";

export type RegisteredAccountType = "FHSA" | "TFSA" | "RRSP" | "RRSP_SPOUSAL";

// ---- room ----

export interface RegisteredRoomRow {
  person_id: string;
  account_type: "FHSA" | "TFSA" | "RRSP";
  tax_year: number;
  room_amount: number;
  as_of: string;
  source: string | null;
}

export function setRoom(row: RegisteredRoomRow): void {
  getDb()
    .prepare(
      `INSERT INTO registered_room (person_id, account_type, tax_year, room_amount, as_of, source)
       VALUES (@person_id, @account_type, @tax_year, @room_amount, @as_of, @source)
       ON CONFLICT(person_id, account_type, tax_year) DO UPDATE SET
         room_amount = excluded.room_amount, as_of = excluded.as_of, source = excluded.source`,
    )
    .run(row);
}

export function roomFor(personId: string, taxYear: number): RegisteredRoomRow[] {
  return getDb()
    .prepare(`SELECT * FROM registered_room WHERE person_id = ? AND tax_year = ?`)
    .all(personId, taxYear) as RegisteredRoomRow[];
}

// ---- contributions ----

export interface RegisteredContributionRow {
  contrib_id: string;
  person_id: string;
  account_type: RegisteredAccountType;
  account_id: string | null;
  date: string;
  amount: number;
  transaction_id: string | null;
  tax_year: number;
  deduction_year: number | null;
  contributor_person_id: string | null;
}

export function recordContribution(row: Omit<RegisteredContributionRow, "contrib_id"> & { contrib_id?: string }): boolean {
  const full: RegisteredContributionRow = { contrib_id: row.contrib_id ?? randomUUID(), ...row };
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO registered_contributions (contrib_id, person_id, account_type, account_id, date, amount, transaction_id, tax_year, deduction_year, contributor_person_id)
       VALUES (@contrib_id, @person_id, @account_type, @account_id, @date, @amount, @transaction_id, @tax_year, @deduction_year, @contributor_person_id)`,
    )
    .run(full);
  return result.changes > 0;
}

export function contributionsFor(personId: string, taxYear: number): RegisteredContributionRow[] {
  return getDb()
    .prepare(`SELECT * FROM registered_contributions WHERE person_id = ? AND tax_year = ? ORDER BY date`)
    .all(personId, taxYear) as RegisteredContributionRow[];
}

export function contributionSum(personId: string, accountType: string, taxYear: number): number {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS s FROM registered_contributions WHERE person_id = ? AND account_type = ? AND tax_year = ?`,
    )
    .get(personId, accountType, taxYear) as { s: number };
  return row.s;
}

export function setDeductionYear(contribId: string, year: number | null): void {
  getDb().prepare(`UPDATE registered_contributions SET deduction_year = ? WHERE contrib_id = ?`).run(year, contribId);
}

// ---- profiles ----

export interface TaxProfileRow {
  person_id: string;
  tax_year: number;
  employment_income: number | null;
  withholding_paid: number | null;
  other_income_json: string | null;
  carryforwards_json: string | null;
  /** What actually lands in the bank weekly — see migration 013. */
  weekly_take_home: number | null;
  updated_at: string;
}

export function upsertTaxProfile(row: TaxProfileRow): void {
  getDb()
    .prepare(
      `INSERT INTO tax_profiles (person_id, tax_year, employment_income, withholding_paid, other_income_json, carryforwards_json, weekly_take_home, updated_at)
       VALUES (@person_id, @tax_year, @employment_income, @withholding_paid, @other_income_json, @carryforwards_json, @weekly_take_home, @updated_at)
       ON CONFLICT(person_id, tax_year) DO UPDATE SET
         employment_income = excluded.employment_income, withholding_paid = excluded.withholding_paid,
         other_income_json = excluded.other_income_json, carryforwards_json = excluded.carryforwards_json,
         weekly_take_home = excluded.weekly_take_home,
         updated_at = excluded.updated_at`,
    )
    .run(row);
}

/**
 * Each person's most recent profile at or before taxYear — the income source
 * the budget view derives its income lines from (a January view shouldn't go
 * blank just because the new year's profile isn't saved yet).
 */
export function latestTaxProfiles(taxYear: number): TaxProfileRow[] {
  return getDb()
    .prepare(
      `SELECT p.* FROM tax_profiles p
       JOIN (
         SELECT person_id, MAX(tax_year) AS tax_year FROM tax_profiles
         WHERE tax_year <= ? GROUP BY person_id
       ) latest ON latest.person_id = p.person_id AND latest.tax_year = p.tax_year`,
    )
    .all(taxYear) as TaxProfileRow[];
}

export function getTaxProfile(personId: string, taxYear: number): TaxProfileRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM tax_profiles WHERE person_id = ? AND tax_year = ?`)
    .get(personId, taxYear) as TaxProfileRow | undefined;
}

// ---- tables ----

/** Latest version of both jurisdictions' tables; seeds 2026 on first use. */
export function latestTaxTables(taxYear: number): TaxTables | null {
  ensureSeeded();
  const load = (jurisdiction: "CA" | "QC"): TaxTablePayload | null => {
    const row = getDb()
      .prepare(
        `SELECT payload_json FROM tax_tables WHERE jurisdiction = ? AND tax_year = ? ORDER BY version DESC LIMIT 1`,
      )
      .get(jurisdiction, taxYear) as { payload_json: string } | undefined;
    return row ? (JSON.parse(row.payload_json) as TaxTablePayload) : null;
  };
  const CA = load("CA");
  const QC = load("QC");
  return CA && QC ? { CA, QC } : null;
}

export function insertTaxTables(jurisdiction: "CA" | "QC", taxYear: number, payload: TaxTablePayload): void {
  const current = getDb()
    .prepare(`SELECT MAX(version) AS v FROM tax_tables WHERE jurisdiction = ? AND tax_year = ?`)
    .get(jurisdiction, taxYear) as { v: number | null };
  getDb()
    .prepare(`INSERT INTO tax_tables (jurisdiction, tax_year, version, payload_json) VALUES (?, ?, ?, ?)`)
    .run(jurisdiction, taxYear, (current.v ?? 0) + 1, JSON.stringify(payload));
}

let seeded = false;
function ensureSeeded(): void {
  if (seeded) return;
  const exists = getDb().prepare(`SELECT 1 FROM tax_tables WHERE tax_year = 2026 LIMIT 1`).get();
  if (!exists) {
    // JSON can't hold Infinity — swap the QC medical maxThreshold sentinel.
    const qc = { ...TAX_TABLES_2026.QC, medical: { ...TAX_TABLES_2026.QC.medical, maxThreshold: 1e12 } };
    insertTaxTables("CA", 2026, TAX_TABLES_2026.CA);
    insertTaxTables("QC", 2026, qc);
  }
  seeded = true;
}

/** Test seam: reset the once-per-process seed latch. */
export function _resetTaxSeedForTests(): void {
  seeded = false;
}

// ---- estimates audit trail ----

export interface TaxEstimateRow {
  estimate_id: string;
  person_id: string | null;
  scenario_id: string | null;
  tax_year: number;
  kind: "estimate" | "optimization";
  computed_at: string;
  inputs_json: string;
  results_json: string;
}

export function saveEstimate(
  input: Omit<TaxEstimateRow, "estimate_id" | "inputs_json" | "results_json"> & { inputs: unknown; results: unknown },
): void {
  getDb()
    .prepare(
      `INSERT INTO tax_estimates (estimate_id, person_id, scenario_id, tax_year, kind, computed_at, inputs_json, results_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      input.person_id,
      input.scenario_id,
      input.tax_year,
      input.kind,
      input.computed_at,
      JSON.stringify(input.inputs),
      JSON.stringify(input.results),
    );
}
