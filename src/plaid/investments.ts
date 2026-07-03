/**
 * plaid/investments.ts — Plaid investments product client calls.
 * Requires PLAID_PRODUCTS to include `investments`.
 *
 * External-flow sign convention (see analytics/portfolio.ts): our stored
 * `amount` is signed cash INTO the account for cash-like types; Plaid's raw
 * amount is positive-for-debit, so cash rows negate.
 */
import type { InvestmentTransaction, Security } from "plaid";
import { requirePlaidClient } from "./client.js";
import type { Vault } from "../vault/vault.js";
import {
  upsertInvestmentTransactions,
  upsertPrices,
  upsertSecurities,
  writeHoldingsSnapshot,
  type InvestmentTxRow,
  type SecurityRow,
} from "../db/repositories/investments.js";

function mapSecurity(sec: Security): SecurityRow {
  return {
    security_id: sec.security_id,
    ticker: sec.ticker_symbol ?? null,
    name: sec.name ?? null,
    sec_type: sec.type ?? null,
    currency: sec.iso_currency_code ?? "CAD",
    isin: sec.isin ?? null,
    raw_json: JSON.stringify(sec),
  };
}

/** Pull current holdings, upsert securities/prices, snapshot positions for today. */
export async function fetchHoldings(vault: Vault, itemId: string): Promise<{ holdings: number; securities: number }> {
  const client = requirePlaidClient(vault);
  const accessToken = vault.getAccessToken(itemId);
  const res = await client.investmentsHoldingsGet({ access_token: accessToken });
  const today = new Date().toISOString().slice(0, 10);

  const securities = res.data.securities.map(mapSecurity);
  upsertSecurities(securities);
  upsertPrices(
    res.data.securities
      .filter((s) => s.close_price != null)
      .map((s) => ({
        security_id: s.security_id,
        date: s.close_price_as_of ?? today,
        close_price: s.close_price!,
        currency: s.iso_currency_code ?? "CAD",
      })),
  );
  const holdings = res.data.holdings.map((h) => ({
    account_id: h.account_id,
    security_id: h.security_id,
    date: today,
    quantity: h.quantity,
    price: h.institution_price ?? null,
    value: h.institution_value ?? 0,
    cost_basis: h.cost_basis ?? null,
    currency: h.iso_currency_code ?? "CAD",
  }));
  writeHoldingsSnapshot(holdings);
  return { holdings: holdings.length, securities: securities.length };
}

type TxType = InvestmentTxRow["tx_type"];

function mapTxType(tx: InvestmentTransaction): TxType {
  const sub = (tx.subtype ?? "").toLowerCase();
  const type = (tx.type ?? "").toLowerCase();
  if (sub.includes("dividend")) return "dividend";
  if (sub.includes("interest")) return "interest";
  if (sub.includes("contribution") || sub.includes("deposit")) return "contribution";
  if (sub.includes("withdrawal")) return "withdrawal";
  if (type === "buy") return "buy";
  if (type === "sell") return "sell";
  if (type === "fee" || sub.includes("fee")) return "fee";
  if (type === "transfer") return "transfer";
  if (type === "cash") return tx.amount <= 0 ? "contribution" : "withdrawal";
  return "other";
}

const CASH_TYPES: ReadonlySet<TxType> = new Set(["dividend", "interest", "contribution", "withdrawal", "fee", "transfer"]);

/** Paged /investments/transactions/get over a date range, normalized and upserted. */
export async function syncInvestmentTransactions(
  vault: Vault,
  itemId: string,
  range: { start: string; end: string },
): Promise<{ transactions: number }> {
  const client = requirePlaidClient(vault);
  const accessToken = vault.getAccessToken(itemId);
  const rows: InvestmentTxRow[] = [];
  let offset = 0;
  for (;;) {
    const res = await client.investmentsTransactionsGet({
      access_token: accessToken,
      start_date: range.start,
      end_date: range.end,
      options: { count: 500, offset },
    });
    upsertSecurities(res.data.securities.map(mapSecurity));
    for (const tx of res.data.investment_transactions) {
      const txType = mapTxType(tx);
      // Cash-like rows: negate Plaid's positive-for-debit into cash-in-positive.
      const amount = CASH_TYPES.has(txType) ? -tx.amount : tx.amount;
      rows.push({
        inv_tx_id: tx.investment_transaction_id,
        account_id: tx.account_id,
        security_id: tx.security_id ?? null,
        date: tx.date,
        tx_type: txType,
        quantity: tx.quantity ?? null,
        price: tx.price ?? null,
        amount,
        currency: tx.iso_currency_code ?? "CAD",
        raw_json: JSON.stringify(tx),
      });
    }
    offset += res.data.investment_transactions.length;
    if (offset >= res.data.total_investment_transactions || res.data.investment_transactions.length === 0) break;
  }
  upsertInvestmentTransactions(rows);
  return { transactions: rows.length };
}
