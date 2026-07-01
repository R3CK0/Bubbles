import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";
import { PlaidCredentials } from "../vault/types.js";

const envMap: Record<PlaidCredentials["env"], string> = {
  sandbox: PlaidEnvironments.sandbox as string,
  development: PlaidEnvironments.development as string,
  production: PlaidEnvironments.production as string,
};

/** Builds a Plaid API client from vault-provided credentials. Never cache this across credential changes. */
export function createPlaidClient(creds: PlaidCredentials): PlaidApi {
  const configuration = new Configuration({
    basePath: envMap[creds.env],
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": creds.clientId,
        "PLAID-SECRET": creds.secret,
      },
    },
  });
  return new PlaidApi(configuration);
}

export function requirePlaidClient(vault: { get(): { plaid: PlaidCredentials | null } }): PlaidApi {
  const creds = vault.get().plaid;
  if (!creds) {
    throw new Error(
      "No Plaid credentials configured. Run: npm run vault -- set-plaid-keys --client-id ... --secret ... --env sandbox",
    );
  }
  return createPlaidClient(creds);
}
