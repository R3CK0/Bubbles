import { Vault } from "../vault/vault.js";
import { createPlaidClient } from "./client.js";
import { deleteItem, listItems, ItemRow } from "../db/repository.js";

export function getLinkedItems(): ItemRow[] {
  return listItems();
}

/** Unlinks a bank: revokes the access token with Plaid and removes it from local storage. */
export async function removeItem(vault: Vault, itemId: string): Promise<void> {
  const linked = vault.get().items[itemId];
  if (!linked) {
    throw new Error(`No linked item found for itemId=${itemId}`);
  }
  const plaidCreds = vault.get().plaid;
  if (plaidCreds) {
    const client = createPlaidClient(plaidCreds);
    try {
      await client.itemRemove({ access_token: linked.accessToken });
    } catch {
      // If Plaid-side removal fails (e.g. already revoked), still clear local state.
    }
  }
  vault.removeLinkedItem(itemId);
  deleteItem(itemId);
}
