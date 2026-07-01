import { Vault, VaultNotInitializedError } from "./vault/vault.js";
import { tryUnlockWithSession, loadSessionMeta } from "./vault/session.js";
import { createApp } from "./server/app.js";
import { config } from "./config.js";
import { getDb } from "./db/db.js";

function unlockVaultOrExit(): Vault {
  if (!Vault.isInitialized()) {
    console.error(
      "Vault has not been initialized yet.\n" +
        "Run: npm run vault -- init\n" +
        "Then: npm run vault -- set-plaid-keys --client-id <id> --secret <secret> --env sandbox",
    );
    process.exit(1);
  }

  const sessionVault = tryUnlockWithSession();
  if (sessionVault) {
    const meta = loadSessionMeta();
    console.log(`[vault] Unlocked via session grant (expires ${meta?.expiresAt}). No YubiKey needed for this boot.`);
    return sessionVault;
  }

  console.log("[vault] No valid session grant found. Falling back to direct YubiKey unlock.");
  console.log("[vault] Insert your YubiKey and follow any PIN/touch prompts...");
  try {
    const vault = Vault.unlockWithYubikey();
    console.log("[vault] Unlocked with physical YubiKey.");
    return vault;
  } catch (err) {
    console.error(
      "[vault] Failed to unlock with the YubiKey:",
      err instanceof Error ? err.message : err,
    );
    console.error(
      "Either plug in the YubiKey and retry, or create a temporary session grant ahead of time with:\n" +
        "  npm run vault -- grant-session",
    );
    process.exit(1);
  }
}

function main() {
  let vault: Vault;
  try {
    vault = unlockVaultOrExit();
  } catch (err) {
    if (err instanceof VaultNotInitializedError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  // Initializes the local SQLite file + schema on first boot.
  getDb();

  const host = process.env.HOST ?? "127.0.0.1";
  const app = createApp(vault);
  app.listen(config.port, host, () => {
    console.log(`Finances backend listening on http://${host}:${config.port}`);
  });
}

main();
