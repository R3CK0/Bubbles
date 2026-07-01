import type { RemovedTransaction, Transaction } from "plaid";
import { queryTransactions, TransactionQuery, TransactionRow } from "../db/repository.js";

export function mapPlaidTransaction(tx: Transaction, itemId: string): TransactionRow {
  return {
    transaction_id: tx.transaction_id,
    account_id: tx.account_id,
    item_id: itemId,
    amount: tx.amount,
    iso_currency_code: tx.iso_currency_code ?? tx.unofficial_currency_code ?? null,
    date: tx.date,
    datetime: tx.datetime ?? null,
    payee: tx.name ?? null,
    merchant_name: tx.merchant_name ?? null,
    type: tx.payment_channel ?? null,
    pending: tx.pending ? 1 : 0,
    personal_finance_category_primary: tx.personal_finance_category?.primary ?? null,
    personal_finance_category_detailed: tx.personal_finance_category?.detailed ?? null,
    removed: 0,
    raw_json: JSON.stringify(tx),
    updated_at: new Date().toISOString(),
  };
}

export function removedTransactionId(tx: RemovedTransaction): string | null {
  return tx.transaction_id ?? null;
}

/** Shape returned by the HTTP API — covers amount, date, type, account, payee, and category. */
export interface ApiTransaction {
  transactionId: string;
  accountId: string;
  amount: number;
  currency: string | null;
  date: string;
  datetime: string | null;
  type: string | null;
  paidTo: string | null;
  category: {
    primary: string | null;
    detailed: string | null;
  };
  pending: boolean;
}

export function toApiTransaction(row: TransactionRow): ApiTransaction {
  return {
    transactionId: row.transaction_id,
    accountId: row.account_id,
    amount: row.amount,
    currency: row.iso_currency_code,
    date: row.date,
    datetime: row.datetime,
    type: row.type,
    paidTo: row.merchant_name ?? row.payee,
    category: {
      primary: row.personal_finance_category_primary,
      detailed: row.personal_finance_category_detailed,
    },
    pending: Boolean(row.pending),
  };
}

export function getTransactions(query: TransactionQuery): ApiTransaction[] {
  return queryTransactions(query).map(toApiTransaction);
}
