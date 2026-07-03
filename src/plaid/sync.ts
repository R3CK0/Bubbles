import { Vault } from "../vault/vault.js";
import { createPlaidClient } from "./client.js";
import { mapPlaidTransaction, removedTransactionId } from "./transactions.js";
import { getItem, listItems, markTransactionRemoved, setSyncCursor, upsertTransaction } from "../db/repository.js";
import { withRetry } from "../util/retry.js";

export interface SyncResult {
  itemId: string;
  added: number;
  modified: number;
  removed: number;
  syncedAt: string;
}

interface PlaidErrorShape {
  status: number | null;
  errorType: string | null;
  errorCode: string | null;
}

function plaidError(err: unknown): PlaidErrorShape {
  const response = (err as { response?: { status?: number; data?: Record<string, unknown> } }).response;
  return {
    status: response?.status ?? null,
    errorType: typeof response?.data?.error_type === "string" ? (response.data.error_type as string) : null,
    errorCode: typeof response?.data?.error_code === "string" ? (response.data.error_code as string) : null,
  };
}

/**
 * Transient Plaid failures worth retrying with backoff:
 *  - 429 / RATE_LIMIT_EXCEEDED (/transactions/sync allows 50 req/min per item)
 *  - 5xx / INTERNAL_SERVER_ERROR / PLANNED_MAINTENANCE
 *  - pure network errors (no HTTP response at all)
 * Auth/config errors (ITEM_LOGIN_REQUIRED, INVALID_ACCESS_TOKEN, …) are not
 * transient — retrying them just burns quota, so they fail fast.
 */
function isRetryablePlaidError(err: unknown): boolean {
  const { status, errorType, errorCode } = plaidError(err);
  if (errorCode === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION") return false; // handled by loop restart
  if (status === 429 || errorType === "RATE_LIMIT_EXCEEDED") return true;
  if (status !== null && status >= 500) return true;
  if (errorCode === "INTERNAL_SERVER_ERROR" || errorCode === "PLANNED_MAINTENANCE") return true;
  if (status === null && err instanceof Error && /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i.test(err.message)) {
    return true;
  }
  return false;
}

const MAX_PAGINATION_RESTARTS = 3;

/**
 * Pulls only what changed since the item's last stored cursor (Plaid's
 * recommended incremental approach). On an item's very first sync the
 * cursor is undefined, so this naturally pulls full history once.
 *
 * Resilience, per Plaid's docs:
 *  - each page request retries transient failures (rate limit, 5xx, network)
 *    with exponential backoff — rate-limit hits wait through the per-minute
 *    window before the next attempt;
 *  - TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION restarts the ENTIRE
 *    pagination loop from the original cursor (never just the failed page);
 *    upserts are idempotent so re-applied pages are harmless;
 *  - count=500 (the maximum) keeps page counts low, which both reduces the
 *    mutation-error window and stays far from the 50 req/min/item limit.
 */
export async function syncItemTransactions(vault: Vault, itemId: string): Promise<SyncResult> {
  const plaidCreds = vault.get().plaid;
  if (!plaidCreds) {
    throw new Error("No Plaid credentials configured in the vault.");
  }

  const client = createPlaidClient(plaidCreds);
  const accessToken = vault.getAccessToken(itemId);
  const itemRow = getItem(itemId);
  const initialCursor: string | undefined = itemRow?.sync_cursor ?? undefined;

  for (let restart = 0; ; restart++) {
    let cursor = initialCursor;
    let added = 0;
    let modified = 0;
    let removed = 0;
    let hasMore = true;

    try {
      while (hasMore) {
        const response = await withRetry(
          () => client.transactionsSync({ access_token: accessToken, cursor, count: 500 }),
          {
            attempts: 4,
            baseDelayMs: 5000,
            maxDelayMs: 65_000, // a rate-limit window is 60s — wait it out
            shouldRetry: isRetryablePlaidError,
            onRetry: (err, attempt, delay) => {
              const { errorCode } = plaidError(err);
              console.warn(
                `[sync] ${itemId} page attempt ${attempt} failed (${errorCode ?? (err instanceof Error ? err.message : err)}) — retrying in ${Math.round(delay / 1000)}s`,
              );
            },
          },
        );
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
    } catch (err) {
      if (
        plaidError(err).errorCode === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" &&
        restart < MAX_PAGINATION_RESTARTS
      ) {
        console.warn(`[sync] ${itemId} data mutated mid-pagination — restarting from the original cursor (restart ${restart + 1}/${MAX_PAGINATION_RESTARTS})`);
        continue;
      }
      throw err;
    }

    const syncedAt = new Date().toISOString();
    setSyncCursor(itemId, cursor ?? "", syncedAt);
    return { itemId, added, modified, removed, syncedAt };
  }
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
