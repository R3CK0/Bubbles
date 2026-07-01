import { Vault } from "../vault/vault.js";
import { createPlaidClient } from "./client.js";
import {
  AccountRow,
  REGISTERED_TYPES,
  RegisteredType,
  getAccount,
  listAccounts,
  personExists,
  updateAccountClassification,
  upsertAccount,
} from "../db/repository.js";

/** An account as exposed by the API: Plaid balances/metadata + classification state. */
export interface ApiAccount {
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
  personId: string | null;
  registeredType: string | null;
  purpose: string | null;
  tracked: boolean;
  isClosed: boolean;
  classifiedAt: string | null;
  updatedAt: string;
}

export function toApiAccount(row: AccountRow): ApiAccount {
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
    personId: row.person_id,
    registeredType: row.registered_type,
    purpose: row.purpose,
    tracked: row.tracked === 1,
    isClosed: row.is_closed === 1,
    classifiedAt: row.classified_at,
    updatedAt: row.updated_at,
  };
}

/** Reads the locally-stored accounts for an item (no Plaid call). */
export function listItemAccounts(itemId: string): ApiAccount[] {
  return listAccounts(itemId).map(toApiAccount);
}

/**
 * Pulls the full account list for an item from Plaid and upserts it. New
 * accounts arrive tracked=1 / unclassified (classified_at = NULL); existing
 * rows keep their classification while balances/metadata refresh. This is what
 * the add-bank wizard calls right after linking so the user has something to
 * classify — and it also guarantees `accounts` rows exist before any
 * transaction sync (whose account_id foreign key would otherwise fail).
 */
export async function fetchItemAccounts(vault: Vault, itemId: string): Promise<ApiAccount[]> {
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

  return listItemAccounts(itemId);
}

export class AccountNotFoundError extends Error {
  readonly status = 404;
}
export class AccountValidationError extends Error {
  readonly status = 400;
}

export interface ClassifyAccountInput {
  personId?: string | null;
  registeredType?: string | null;
  purpose?: string | null;
  tracked?: boolean;
  isClosed?: boolean;
}

/**
 * Records the user's decision about what an account is and whether to track it.
 * Stamps classified_at so the account leaves the awaiting-classification state
 * the onboarding wizard gates on.
 */
export function classifyAccount(accountId: string, input: ClassifyAccountInput): ApiAccount {
  const existing = getAccount(accountId);
  if (!existing) {
    throw new AccountNotFoundError(`No account found for accountId=${accountId}`);
  }

  if (input.personId != null && !personExists(input.personId)) {
    throw new AccountValidationError(`Unknown personId=${input.personId}`);
  }
  if (
    input.registeredType != null &&
    !REGISTERED_TYPES.includes(input.registeredType as RegisteredType)
  ) {
    throw new AccountValidationError(
      `registeredType must be one of ${REGISTERED_TYPES.join(", ")} (or null)`,
    );
  }

  updateAccountClassification(accountId, {
    ...(input.personId !== undefined ? { person_id: input.personId } : {}),
    ...(input.registeredType !== undefined
      ? { registered_type: input.registeredType as RegisteredType | null }
      : {}),
    ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
    ...(input.tracked !== undefined ? { tracked: input.tracked ? 1 : 0 } : {}),
    ...(input.isClosed !== undefined ? { is_closed: input.isClosed ? 1 : 0 } : {}),
    classified_at: new Date().toISOString(),
  });

  return toApiAccount(getAccount(accountId)!);
}
