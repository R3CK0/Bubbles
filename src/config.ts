import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");

const dataDir = process.env.FINANCES_DATA_DIR
  ? path.resolve(process.env.FINANCES_DATA_DIR)
  : path.join(projectRoot, "data");

const vaultDir = path.join(dataDir, "vault");

export const config = {
  port: Number(process.env.PORT ?? 4000),
  dataDir,
  vaultDir,
  dbPath: path.join(dataDir, "finances.db"),
  vault: {
    identityPath: path.join(vaultDir, "identity.txt"),
    recipientPath: path.join(vaultDir, "recipient.txt"),
    secretsPath: path.join(vaultDir, "secrets.age"),
    sessionKeyServiceName: "finances-vault-session",
    sessionKeyAccount: "session-key",
    sessionMetaPath: path.join(vaultDir, "session.json"),
    sessionSecretsPath: path.join(vaultDir, "session.secrets.enc"),
    sessionKeyFallbackPath: path.join(vaultDir, "session.key"),
  },
  session: {
    maxDays: 30,
    defaultDays: 30,
  },
  plaid: {
    defaultCountryCodes: (process.env.PLAID_COUNTRY_CODES ?? "US").split(","),
    defaultLanguage: process.env.PLAID_LANGUAGE ?? "en",
    products: (process.env.PLAID_PRODUCTS ?? "transactions").split(","),
  },
} as const;
