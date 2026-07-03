import { getDb } from "./db.js";

export interface ItemRow {
  item_id: string;
  institution_id: string | null;
  institution_name: string | null;
  linked_at: string;
  last_synced_at: string | null;
  sync_cursor: string | null;
}

/** The balance/metadata columns Plaid owns — the only fields a sync/refresh writes. */
export interface AccountUpsert {
  account_id: string;
  item_id: string;
  name: string | null;
  official_name: string | null;
  mask: string | null;
  type: string | null;
  subtype: string | null;
  current_balance: number | null;
  available_balance: number | null;
  iso_currency_code: string | null;
  updated_at: string;
}

/** A full accounts row: Plaid-owned fields plus the user-owned classification fields. */
export interface AccountRow extends AccountUpsert {
  person_id: string | null;
  registered_type: string | null;
  purpose: string | null;
  tracked: number;
  classified_at: string | null;
  is_closed: number;
}

/** The registered-account types accepted by the accounts CHECK constraint. */
export const REGISTERED_TYPES = ["FHSA", "TFSA", "RRSP", "RESP", "NONREG"] as const;
export type RegisteredType = (typeof REGISTERED_TYPES)[number];

export interface TransactionRow {
  transaction_id: string;
  account_id: string;
  item_id: string;
  amount: number;
  iso_currency_code: string | null;
  date: string;
  datetime: string | null;
  payee: string | null;
  merchant_name: string | null;
  type: string | null;
  pending: number;
  personal_finance_category_primary: string | null;
  personal_finance_category_detailed: string | null;
  removed: number;
  raw_json: string | null;
  updated_at: string;
}

export interface PersonRow {
  person_id: string;
  display_name: string;
  color: string | null;
  created_at: string;
}

export function listPersons(): PersonRow[] {
  return getDb().prepare(`SELECT * FROM persons ORDER BY created_at`).all() as PersonRow[];
}

export function personExists(personId: string): boolean {
  return Boolean(getDb().prepare(`SELECT 1 FROM persons WHERE person_id = ?`).get(personId));
}

export function insertPerson(personId: string, displayName: string, color: string | null): PersonRow {
  getDb()
    .prepare(
      `INSERT INTO persons (person_id, display_name, color, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(person_id) DO UPDATE SET display_name = excluded.display_name, color = excluded.color`,
    )
    .run(personId, displayName, color, new Date().toISOString());
  return getDb().prepare(`SELECT * FROM persons WHERE person_id = ?`).get(personId) as PersonRow;
}

export function upsertItem(row: Omit<ItemRow, "sync_cursor" | "last_synced_at"> & Partial<Pick<ItemRow, "sync_cursor" | "last_synced_at">>) {
  getDb()
    .prepare(
      `INSERT INTO items (item_id, institution_id, institution_name, linked_at, last_synced_at, sync_cursor)
       VALUES (@item_id, @institution_id, @institution_name, @linked_at, @last_synced_at, @sync_cursor)
       ON CONFLICT(item_id) DO UPDATE SET
         institution_id = excluded.institution_id,
         institution_name = excluded.institution_name`,
    )
    .run({
      item_id: row.item_id,
      institution_id: row.institution_id,
      institution_name: row.institution_name,
      linked_at: row.linked_at,
      last_synced_at: row.last_synced_at ?? null,
      sync_cursor: row.sync_cursor ?? null,
    });
}

export function listItems(): ItemRow[] {
  return getDb().prepare(`SELECT * FROM items ORDER BY linked_at DESC`).all() as ItemRow[];
}

export function getItem(itemId: string): ItemRow | undefined {
  return getDb().prepare(`SELECT * FROM items WHERE item_id = ?`).get(itemId) as ItemRow | undefined;
}

export function deleteItem(itemId: string) {
  getDb().prepare(`DELETE FROM items WHERE item_id = ?`).run(itemId);
}

export function setSyncCursor(itemId: string, cursor: string, syncedAt: string) {
  getDb()
    .prepare(`UPDATE items SET sync_cursor = ?, last_synced_at = ? WHERE item_id = ?`)
    .run(cursor, syncedAt, itemId);
}

// New rows land with tracked=1 / classified_at=NULL (the awaiting-classification
// state). ON CONFLICT only touches Plaid-owned balance/metadata columns, so a
// refresh or re-sync never clobbers the user's classification choices.
export function upsertAccount(row: AccountUpsert) {
  getDb()
    .prepare(
      `INSERT INTO accounts (account_id, item_id, name, official_name, mask, type, subtype, current_balance, available_balance, iso_currency_code, updated_at)
       VALUES (@account_id, @item_id, @name, @official_name, @mask, @type, @subtype, @current_balance, @available_balance, @iso_currency_code, @updated_at)
       ON CONFLICT(account_id) DO UPDATE SET
         name = excluded.name,
         official_name = excluded.official_name,
         mask = excluded.mask,
         type = excluded.type,
         subtype = excluded.subtype,
         current_balance = excluded.current_balance,
         available_balance = excluded.available_balance,
         iso_currency_code = excluded.iso_currency_code,
         updated_at = excluded.updated_at`,
    )
    .run(row);
}

export function listAccounts(itemId?: string): AccountRow[] {
  if (itemId) {
    return getDb()
      .prepare(`SELECT * FROM accounts WHERE item_id = ? ORDER BY name`)
      .all(itemId) as AccountRow[];
  }
  return getDb().prepare(`SELECT * FROM accounts ORDER BY name`).all() as AccountRow[];
}

export function getAccount(accountId: string): AccountRow | undefined {
  return getDb().prepare(`SELECT * FROM accounts WHERE account_id = ?`).get(accountId) as
    | AccountRow
    | undefined;
}

export interface AccountClassification {
  person_id?: string | null;
  registered_type?: RegisteredType | null;
  purpose?: string | null;
  tracked?: number;
  is_closed?: number;
  classified_at: string;
}

/**
 * Applies the user's classification choices from the add-bank wizard. Only the
 * fields present in `patch` are written; `classified_at` is always stamped so
 * the row leaves the awaiting-classification state.
 */
export function updateAccountClassification(accountId: string, patch: AccountClassification): void {
  const sets: string[] = [];
  const params: Record<string, unknown> = { account_id: accountId };

  for (const field of ["person_id", "registered_type", "purpose", "tracked", "is_closed"] as const) {
    if (field in patch && patch[field] !== undefined) {
      sets.push(`${field} = @${field}`);
      params[field] = patch[field];
    }
  }
  sets.push("classified_at = @classified_at");
  params.classified_at = patch.classified_at;

  getDb()
    .prepare(`UPDATE accounts SET ${sets.join(", ")} WHERE account_id = @account_id`)
    .run(params);
}

export function upsertTransaction(row: TransactionRow) {
  getDb()
    .prepare(
      `INSERT INTO transactions (transaction_id, account_id, item_id, amount, iso_currency_code, date, datetime, payee, merchant_name, type, pending, personal_finance_category_primary, personal_finance_category_detailed, removed, raw_json, updated_at)
       VALUES (@transaction_id, @account_id, @item_id, @amount, @iso_currency_code, @date, @datetime, @payee, @merchant_name, @type, @pending, @personal_finance_category_primary, @personal_finance_category_detailed, @removed, @raw_json, @updated_at)
       ON CONFLICT(transaction_id) DO UPDATE SET
         account_id = excluded.account_id,
         item_id = excluded.item_id,
         amount = excluded.amount,
         iso_currency_code = excluded.iso_currency_code,
         date = excluded.date,
         datetime = excluded.datetime,
         payee = excluded.payee,
         merchant_name = excluded.merchant_name,
         type = excluded.type,
         pending = excluded.pending,
         personal_finance_category_primary = excluded.personal_finance_category_primary,
         personal_finance_category_detailed = excluded.personal_finance_category_detailed,
         removed = excluded.removed,
         raw_json = excluded.raw_json,
         updated_at = excluded.updated_at`,
    )
    .run(row);
}

export function markTransactionRemoved(transactionId: string, updatedAt: string) {
  getDb()
    .prepare(`UPDATE transactions SET removed = 1, updated_at = ? WHERE transaction_id = ?`)
    .run(updatedAt, transactionId);
}

export interface TransactionQuery {
  startDate?: string;
  endDate?: string;
  accountId?: string;
  itemId?: string;
  includeRemoved?: boolean;
  limit?: number;
  offset?: number;
}

export function queryTransactions(q: TransactionQuery): TransactionRow[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};

  if (q.startDate) {
    clauses.push("date >= @startDate");
    params.startDate = q.startDate;
  }
  if (q.endDate) {
    clauses.push("date <= @endDate");
    params.endDate = q.endDate;
  }
  if (q.accountId) {
    clauses.push("account_id = @accountId");
    params.accountId = q.accountId;
  }
  if (q.itemId) {
    clauses.push("item_id = @itemId");
    params.itemId = q.itemId;
  }
  if (!q.includeRemoved) {
    clauses.push("removed = 0");
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.min(q.limit ?? 250, 1000);
  const offset = q.offset ?? 0;

  return getDb()
    .prepare(`SELECT * FROM transactions ${where} ORDER BY date DESC, transaction_id LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit, offset }) as TransactionRow[];
}
