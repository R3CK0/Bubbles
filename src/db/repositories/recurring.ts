/**
 * db/repositories/recurring.ts — data access for the recurring-payment registry.
 */
import { randomUUID } from "node:crypto";
import { getDb } from "../db.js";
import type { DetectedCandidate, RecurringEntry } from "../../analytics/recurring.js";
import { normalizeMerchant } from "../../analytics/recurring.js";

export interface RecurringPaymentRow {
  rp_id: string;
  name: string;
  category_id: string | null;
  person_id: string | null;
  account_id: string | null;
  expected_amount: number;
  amount_tolerance: number;
  currency: string;
  frequency: "weekly" | "biweekly" | "monthly" | "quarterly" | "semiannual" | "annual" | "custom";
  interval_days: number | null;
  anchor_date: string;
  next_due_date: string;
  end_date: string | null;
  autopay: number;
  reimbursed_by: "work" | "buildings" | null;
  debt_id: string | null;
  source: "manual" | "detected";
  status: "active" | "paused" | "ended" | "proposed";
  created_at: string;
}

export function toRecurringEntry(row: RecurringPaymentRow): RecurringEntry {
  return {
    rpId: row.rp_id,
    name: row.name,
    expectedAmount: row.expected_amount,
    amountTolerance: row.amount_tolerance,
    frequency: row.frequency,
    intervalDays: row.interval_days,
    anchorDate: row.anchor_date,
    nextDueDate: row.next_due_date,
    endDate: row.end_date,
  };
}

export function listRecurring(status?: RecurringPaymentRow["status"]): RecurringPaymentRow[] {
  if (status) {
    return getDb()
      .prepare(`SELECT * FROM recurring_payments WHERE status = ? ORDER BY next_due_date, name`)
      .all(status) as RecurringPaymentRow[];
  }
  return getDb()
    .prepare(`SELECT * FROM recurring_payments ORDER BY next_due_date, name`)
    .all() as RecurringPaymentRow[];
}

export function getRecurring(rpId: string): RecurringPaymentRow | undefined {
  return getDb().prepare(`SELECT * FROM recurring_payments WHERE rp_id = ?`).get(rpId) as
    | RecurringPaymentRow
    | undefined;
}

export function upsertRecurring(row: RecurringPaymentRow): void {
  getDb()
    .prepare(
      `INSERT INTO recurring_payments (rp_id, name, category_id, person_id, account_id, expected_amount, amount_tolerance, currency, frequency, interval_days, anchor_date, next_due_date, end_date, autopay, reimbursed_by, debt_id, source, status, created_at)
       VALUES (@rp_id, @name, @category_id, @person_id, @account_id, @expected_amount, @amount_tolerance, @currency, @frequency, @interval_days, @anchor_date, @next_due_date, @end_date, @autopay, @reimbursed_by, @debt_id, @source, @status, @created_at)
       ON CONFLICT(rp_id) DO UPDATE SET
         name = excluded.name, category_id = excluded.category_id, person_id = excluded.person_id,
         account_id = excluded.account_id, expected_amount = excluded.expected_amount,
         amount_tolerance = excluded.amount_tolerance, currency = excluded.currency,
         frequency = excluded.frequency, interval_days = excluded.interval_days,
         anchor_date = excluded.anchor_date, next_due_date = excluded.next_due_date,
         end_date = excluded.end_date, autopay = excluded.autopay,
         reimbursed_by = excluded.reimbursed_by, debt_id = excluded.debt_id, status = excluded.status`,
    )
    .run(row);
}

export function setRecurringStatus(rpId: string, status: RecurringPaymentRow["status"]): void {
  getDb().prepare(`UPDATE recurring_payments SET status = ? WHERE rp_id = ?`).run(status, rpId);
}

export function deleteRecurring(rpId: string): void {
  getDb().prepare(`DELETE FROM recurring_payments WHERE rp_id = ?`).run(rpId);
}

/**
 * Insert detected candidates as status='proposed', skipping candidates whose
 * normalized name already exists in the registry (any status).
 */
export function proposeDetected(candidates: DetectedCandidate[], now: string): number {
  const existing = listRecurring().map((r) => normalizeMerchant(r.name));
  let inserted = 0;
  for (const c of candidates) {
    if (existing.some((name) => name && (name.includes(c.normalizedName) || c.normalizedName.includes(name)))) {
      continue;
    }
    upsertRecurring({
      rp_id: randomUUID(),
      name: c.name,
      category_id: null,
      person_id: null,
      account_id: null,
      expected_amount: c.expectedAmount,
      amount_tolerance: 0.05,
      currency: "CAD",
      frequency: c.frequency,
      interval_days: null,
      anchor_date: c.anchorDate,
      next_due_date: c.anchorDate,
      end_date: null,
      autopay: 1,
      reimbursed_by: null,
      debt_id: null,
      source: "detected",
      status: "proposed",
      created_at: now,
    });
    existing.push(c.normalizedName);
    inserted++;
  }
  return inserted;
}

export function linkTransaction(
  transactionId: string,
  rpId: string,
  reimbursedBy: "work" | "buildings" | null = null,
): void {
  // a bill marked "work/buildings pays" stamps its matches so cashflow
  // excludes them; COALESCE keeps any manual per-transaction flag
  getDb()
    .prepare(
      `UPDATE transactions SET recurring_payment_id = ?, reimbursed_by = COALESCE(?, reimbursed_by)
       WHERE transaction_id = ?`,
    )
    .run(rpId, reimbursedBy, transactionId);
}

/** Retro-stamp a bill's reimbursed_by onto its already-matched transactions. */
export function propagateReimbursement(rpId: string, reimbursedBy: "work" | "buildings"): number {
  return getDb()
    .prepare(`UPDATE transactions SET reimbursed_by = ? WHERE recurring_payment_id = ?`)
    .run(reimbursedBy, rpId).changes;
}

export function advanceNextDue(rpId: string, nextDueDate: string): void {
  getDb().prepare(`UPDATE recurring_payments SET next_due_date = ? WHERE rp_id = ?`).run(nextDueDate, rpId);
}

/** Matched charge amounts over time (price-history sparkline + creep input). */
export function amountHistory(rpId: string): { date: string; amount: number }[] {
  return getDb()
    .prepare(
      `SELECT date, amount FROM transactions WHERE recurring_payment_id = ? AND removed = 0 ORDER BY date`,
    )
    .all(rpId) as { date: string; amount: number }[];
}

/** Transactions in range not yet linked to any recurring payment. */
export function unlinkedChargeIds(range: { start: string; end: string }): string[] {
  return (
    getDb()
      .prepare(
        `SELECT t.transaction_id FROM transactions t
         JOIN accounts a ON a.account_id = t.account_id
         WHERE t.removed = 0 AND a.tracked = 1 AND t.recurring_payment_id IS NULL
           AND t.amount > 0 AND t.is_transfer = 0 AND t.date >= ? AND t.date <= ?`,
      )
      .all(range.start, range.end) as { transaction_id: string }[]
  ).map((r) => r.transaction_id);
}
