import { Vault } from "../vault/vault.js";
import { createPlaidClient } from "./client.js";
import { mapPlaidTransaction, removedTransactionId } from "./transactions.js";
import { getItem, listItems, markTransactionRemoved, setSyncCursor, upsertTransaction } from "../db/repository.js";

export interface SyncResult {
  itemId: string;
  added: number;
  modified: number;
  removed: number;
  syncedAt: string;
}

/**
 * Pulls only what changed since the item's last stored cursor (Plaid's
 * recommended incremental approach). On an item's very first sync the
 * cursor is undefined, so this naturally pulls full history once.
 */
export async function syncItemTransactions(vault: Vault, itemId: string): Promise<SyncResult> {
  const plaidCreds = vault.get().plaid;
  if (!plaidCreds) {
    throw new Error("No Plaid credentials configured in the vault.");
  }

  const client = createPlaidClient(plaidCreds);
  const accessToken = vault.getAccessToken(itemId);
  const itemRow = getItem(itemId);
  let cursor: string | undefined = itemRow?.sync_cursor ?? undefined;

  let added = 0;
  let modified = 0;
  let removed = 0;
  let hasMore = true;

  while (hasMore) {
    const response = await client.transactionsSync({ access_token: accessToken, cursor });
    const data = response.data;

    for (const tx of data.added) {
      upsertTransaction(mapPlaidTransaction(tx, itemId));
      added++;
    }
    for (const tx of data.modified) {
      upsertTransaction(mapPlaidTransaction(tx, itemId));
      modified++;
    }
    for (const tx of data.removed) {
      const id = removedTransactionId(tx);
      if (id) {
        markTransactionRemoved(id, new Date().toISOString());
        removed++;
      }
    }

    cursor = data.next_cursor;
    hasMore = data.has_more;
  }

  const syncedAt = new Date().toISOString();
  setSyncCursor(itemId, cursor ?? "", syncedAt);

  return { itemId, added, modified, removed, syncedAt };
}

export interface SyncAllResult {
  results: SyncResult[];
  errors: Array<{ itemId: string; error: string }>;
}

/** Syncs every linked item. A failure on one bank doesn't block the others. */
export async function syncAllItems(vault: Vault): Promise<SyncAllResult> {
  const results: SyncResult[] = [];
  const errors: Array<{ itemId: string; error: string }> = [];

  for (const item of listItems()) {
    try {
      results.push(await syncItemTransactions(vault, item.item_id));
    } catch (err) {
      errors.push({ itemId: item.item_id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { results, errors };
}
