import { CountryCode, Products } from "plaid";
import { Vault } from "../vault/vault.js";
import { requirePlaidClient } from "./client.js";
import { config } from "../config.js";
import { upsertItem } from "../db/repository.js";
import { fetchItemAccounts } from "./accounts.js";

const PRODUCT_MAP: Record<string, Products> = {
  transactions: Products.Transactions,
  auth: Products.Auth,
  identity: Products.Identity,
  assets: Products.Assets,
};

const COUNTRY_MAP: Record<string, CountryCode> = {
  US: CountryCode.Us,
  CA: CountryCode.Ca,
  GB: CountryCode.Gb,
};

function resolveProducts(): Products[] {
  return config.plaid.products
    .map((p) => PRODUCT_MAP[p.trim().toLowerCase()])
    .filter((p): p is Products => Boolean(p));
}

function resolveCountryCodes(): CountryCode[] {
  return config.plaid.defaultCountryCodes
    .map((c) => COUNTRY_MAP[c.trim().toUpperCase()])
    .filter((c): c is CountryCode => Boolean(c));
}

/** Creates a Link token for the frontend Plaid Link widget (see public/link-test.html). */
export async function createLinkToken(vault: Vault, clientUserId: string): Promise<string> {
  const client = requirePlaidClient(vault);
  const response = await client.linkTokenCreate({
    user: { client_user_id: clientUserId },
    client_name: "Finances",
    products: resolveProducts(),
    country_codes: resolveCountryCodes(),
    language: config.plaid.defaultLanguage,
  });
  return response.data.link_token;
}

export interface ExchangeResult {
  itemId: string;
  institutionId: string | null;
  institutionName: string | null;
  accountsFetched: number;
}

/**
 * Exchanges a Link `public_token` for a permanent access token, stores the
 * access token in the vault (never in the SQLite DB), and records
 * non-sensitive item metadata locally.
 */
export async function exchangePublicToken(vault: Vault, publicToken: string): Promise<ExchangeResult> {
  const client = requirePlaidClient(vault);

  const exchange = await client.itemPublicTokenExchange({ public_token: publicToken });
  const accessToken = exchange.data.access_token;
  const itemId = exchange.data.item_id;

  let institutionId: string | null = null;
  let institutionName: string | null = null;

  try {
    const itemResponse = await client.itemGet({ access_token: accessToken });
    institutionId = itemResponse.data.item.institution_id ?? null;
    if (institutionId) {
      const instResponse = await client.institutionsGetById({
        institution_id: institutionId,
        country_codes: resolveCountryCodes(),
      });
      institutionName = instResponse.data.institution.name;
    }
  } catch {
    // Institution lookup is best-effort metadata; the item is already linked either way.
  }

  const linkedAt = new Date().toISOString();

  vault.upsertLinkedItem({
    itemId,
    accessToken,
    institutionId: institutionId ?? "",
    institutionName: institutionName ?? "Unknown institution",
    linkedAt,
  });

  upsertItem({
    item_id: itemId,
    institution_id: institutionId,
    institution_name: institutionName,
    linked_at: linkedAt,
  });

  // Pull the item's accounts immediately so they're ready for the classify
  // wizard — and so `accounts` rows exist before any transaction sync (whose
  // account_id foreign key would otherwise fail on a brand-new item).
  // Best-effort: the item is linked either way, and the accounts can be
  // re-fetched via POST /api/items/:itemId/accounts/refresh.
  let accountsFetched = 0;
  try {
    accountsFetched = (await fetchItemAccounts(vault, itemId)).length;
  } catch {
    // Swallow — link succeeded; the wizard's refresh step will retry the pull.
  }

  return { itemId, institutionId, institutionName, accountsFetched };
}
