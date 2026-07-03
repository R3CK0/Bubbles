/**
 * db/repositories/debts.ts — data access for debts and rate history.
 */
import { randomUUID } from "node:crypto";
import { getDb } from "../db.js";
import type { DebtInput } from "../../analytics/debt.js";

export interface DebtRow {
  debt_id: string;
  person_id: string | null;
  account_id: string | null;
  name: string;
  kind: "credit_card" | "student_loan" | "line_of_credit" | "auto_loan" | "mortgage" | "personal" | "other";
  original_principal: number | null;
  current_balance: number;
  apr: number;
  min_payment: number | null;
  payment_day: number | null;
  maturity_date: string | null;
  status: "active" | "paid_off" | "archived";
  created_at: string;
}

export function toDebtInput(row: DebtRow): DebtInput {
  return {
    debtId: row.debt_id,
    name: row.name,
    currentBalance: row.current_balance,
    apr: row.apr,
    minPayment: row.min_payment,
  };
}

export function listDebts(status: DebtRow["status"] | "all" = "active"): DebtRow[] {
  if (status === "all") {
    return getDb().prepare(`SELECT * FROM debts ORDER BY apr DESC`).all() as DebtRow[];
  }
  return getDb().prepare(`SELECT * FROM debts WHERE status = ? ORDER BY apr DESC`).all(status) as DebtRow[];
}

export function getDebt(debtId: string): DebtRow | undefined {
  return getDb().prepare(`SELECT * FROM debts WHERE debt_id = ?`).get(debtId) as DebtRow | undefined;
}

export interface DebtCreate {
  personId?: string | null;
  accountId?: string | null;
  name: string;
  kind: DebtRow["kind"];
  originalPrincipal?: number | null;
  currentBalance: number;
  apr: number;
  minPayment?: number | null;
  paymentDay?: number | null;
  maturityDate?: string | null;
}

export function createDebt(input: DebtCreate, now: string): DebtRow {
  const row: DebtRow = {
    debt_id: randomUUID(),
    person_id: input.personId ?? null,
    account_id: input.accountId ?? null,
    name: input.name,
    kind: input.kind,
    original_principal: input.originalPrincipal ?? null,
    current_balance: input.currentBalance,
    apr: input.apr,
    min_payment: input.minPayment ?? null,
    payment_day: input.paymentDay ?? null,
    maturity_date: input.maturityDate ?? null,
    status: "active",
    created_at: now,
  };
  getDb()
    .prepare(
      `INSERT INTO debts (debt_id, person_id, account_id, name, kind, original_principal, current_balance, apr, min_payment, payment_day, maturity_date, status, created_at)
       VALUES (@debt_id, @person_id, @account_id, @name, @kind, @original_principal, @current_balance, @apr, @min_payment, @payment_day, @maturity_date, @status, @created_at)`,
    )
    .run(row);
  return row;
}

const PATCHABLE = new Set([
  "person_id",
  "account_id",
  "name",
  "kind",
  "original_principal",
  "current_balance",
  "apr",
  "min_payment",
  "payment_day",
  "maturity_date",
  "status",
]);

export function updateDebt(debtId: string, patch: Partial<DebtRow>): DebtRow | undefined {
  const sets: string[] = [];
  const params: Record<string, unknown> = { debt_id: debtId };
  for (const [key, value] of Object.entries(patch)) {
    if (!PATCHABLE.has(key) || value === undefined) continue;
    sets.push(`${key} = @${key}`);
    params[key] = value;
  }
  if (sets.length > 0) {
    getDb().prepare(`UPDATE debts SET ${sets.join(", ")} WHERE debt_id = @debt_id`).run(params);
    if ("apr" in patch && typeof patch.apr === "number") {
      addRateChange(debtId, new Date().toISOString().slice(0, 10), patch.apr);
    }
  }
  return getDebt(debtId);
}

export function addRateChange(debtId: string, effectiveDate: string, apr: number): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO debt_rate_history (debt_id, effective_date, apr) VALUES (?, ?, ?)`,
    )
    .run(debtId, effectiveDate, apr);
}

export function rateHistory(debtId: string): { effective_date: string; apr: number }[] {
  return getDb()
    .prepare(`SELECT effective_date, apr FROM debt_rate_history WHERE debt_id = ? ORDER BY effective_date`)
    .all(debtId) as { effective_date: string; apr: number }[];
}

// ---- monthly statements (pay-by dates for revolving debt) ----

export interface DebtStatementRow {
  debt_id: string;
  month: string; // YYYY-MM
  due_date: string; // YYYY-MM-DD
  statement_balance: number | null;
  minimum_due: number | null;
  created_at: string;
}

export function upsertDebtStatement(row: DebtStatementRow): void {
  getDb()
    .prepare(
      `INSERT INTO debt_statements (debt_id, month, due_date, statement_balance, minimum_due, created_at)
       VALUES (@debt_id, @month, @due_date, @statement_balance, @minimum_due, @created_at)
       ON CONFLICT(debt_id, month) DO UPDATE SET
         due_date = excluded.due_date,
         statement_balance = excluded.statement_balance,
         minimum_due = excluded.minimum_due`,
    )
    .run(row);
}

export function statementsForMonth(month: string): Map<string, DebtStatementRow> {
  const rows = getDb()
    .prepare(`SELECT * FROM debt_statements WHERE month = ?`)
    .all(month) as DebtStatementRow[];
  return new Map(rows.map((r) => [r.debt_id, r]));
}

/**
 * Net transaction flow on an account over a range (Plaid sign convention:
 * positive = money out / new charges, negative = payments in). For a credit
 * account, current_balance − this net change recovers the start-of-range
 * balance — the fallback statement balance.
 */
export function accountNetChange(accountId: string, range: { start: string; end: string }): number {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS net FROM transactions
       WHERE account_id = ? AND removed = 0 AND date >= ? AND date <= ?`,
    )
    .get(accountId, range.start, range.end) as { net: number };
  return row.net;
}

/**
 * For Plaid-linked debts (credit cards), pull the live balance from the
 * accounts row. Plaid reports credit balances positive-owing.
 */
export function refreshBalancesFromAccounts(): number {
  return getDb()
    .prepare(
      `UPDATE debts SET current_balance = (
         SELECT ABS(a.current_balance) FROM accounts a WHERE a.account_id = debts.account_id
       )
       WHERE account_id IS NOT NULL AND status = 'active'
         AND EXISTS (SELECT 1 FROM accounts a WHERE a.account_id = debts.account_id AND a.current_balance IS NOT NULL)`,
    )
    .run().changes;
}
