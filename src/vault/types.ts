export interface PlaidCredentials {
  clientId: string;
  secret: string;
  env: "sandbox" | "development" | "production";
}

export interface LinkedItemSecret {
  itemId: string;
  accessToken: string;
  institutionId: string;
  institutionName: string;
  linkedAt: string;
}

/** Shape of the plaintext JSON that lives inside the encrypted vault. */
export interface VaultSecrets {
  plaid: PlaidCredentials | null;
  /** Keyed by Plaid item_id. Access tokens are as sensitive as bank passwords. */
  items: Record<string, LinkedItemSecret>;
}

export function emptyVaultSecrets(): VaultSecrets {
  return { plaid: null, items: {} };
}
