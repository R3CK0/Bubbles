import { Vault } from "../vault/vault.js";
import { createPlaidClient } from "./client.js";
import { listAccounts, upsertAccount, AccountRow } from "../db/repository.js";

export interface ApiBalance {
  accountId: string;
  itemId: string;
  name: string | null;
  officialName: string | null;
  mask: string | null;
  type: string | null;
  subtype: string | null;
  currentBalance: number | null;
  availableBalance: number | null;
  currency: string | null;
  updatedAt: string;
}

function toApiBalance(row: AccountRow): ApiBalance {
  return {
    accountId: row.account_id,
    itemId: row.item_id,
    name: row.name,
    officialName: row.official_name,
    mask: row.mask,
    type: row.type,
    subtype: row.subtype,
    currentBalance: row.current_balance,
    availableBalance: row.available_balance,
    currency: row.iso_currency_code,
    updatedAt: row.updated_at,
  };
}

/** Live balance pull from Plaid for one item; refreshes the local cache. */
export async function refreshAccountBalances(vault: Vault, itemId: string): Promise<ApiBalance[]> {
  const plaidCreds = vault.get().plaid;
  if (!plaidCreds) {
    throw new Error("No Plaid credentials configured in the vault.");
  }
  const client = createPlaidClient(plaidCreds);
  const accessToken = vault.getAccessToken(itemId);

  const response = await client.accountsBalanceGet({ access_token: accessToken });
  const updatedAt = new Date().toISOString();

  for (const account of response.data.accounts) {
    upsertAccount({
      account_id: account.account_id,
      item_id: itemId,
      name: account.name ?? null,
      official_name: account.official_name ?? null,
      mask: account.mask ?? null,
      type: account.type ?? null,
      subtype: account.subtype ?? null,
      current_balance: account.balances.current ?? null,
      available_balance: account.balances.available ?? null,
      iso_currency_code: account.balances.iso_currency_code ?? null,
      updated_at: updatedAt,
    });
  }

  return listAccounts(itemId).map(toApiBalance);
}

/** Reads cached balances from local storage without calling Plaid. */
export function getCachedBalances(itemId?: string): ApiBalance[] {
  return listAccounts(itemId).map(toApiBalance);
}
