import { Vault, VaultNotInitializedError } from "./vault/vault.js";
import { tryUnlockWithSession, loadSessionMeta } from "./vault/session.js";
import { createApp } from "./server/app.js";
import { ensureVault } from "./server/middleware/vaultGuard.js";
import { config } from "./config.js";
import { getDb } from "./db/db.js";
import { startScheduler } from "./jobs/scheduler.js";

/**
 * Try to unlock the vault; return null (degraded mode) when it can't be.
 * The engine routes and the whole dashboard run DB-only — only the Plaid
 * routers 503 while locked, and the web app shows its vault banner.
 */
function tryUnlockVault(): Vault | null {
  if (!Vault.isInitialized()) {
    console.warn(
      "[vault] Not initialized — Plaid sync disabled. To enable:\n" +
        "  npm run vault -- init\n" +
        "  npm run vault -- set-plaid-keys --client-id <id> --secret <secret> --env sandbox",
    );
    return null;
  }

  const sessionVault = tryUnlockWithSession();
  if (sessionVault) {
    const meta = loadSessionMeta();
    console.log(`[vault] Unlocked via session grant (expires ${meta?.expiresAt}). No YubiKey needed for this boot.`);
    return sessionVault;
  }

  if (!process.stdin.isTTY) {
    console.warn(
      "[vault] No session grant and no terminal for YubiKey prompts — booting LOCKED.\n" +
        "Dashboards work from local data; run `npm run vault -- grant-session` to enable sync.",
    );
    return null;
  }

  console.log("[vault] No valid session grant found. Falling back to direct YubiKey unlock.");
  console.log("[vault] Insert your YubiKey and follow any PIN/touch prompts...");
  try {
    const vault = Vault.unlockWithYubikey();
    console.log("[vault] Unlocked with physical YubiKey.");
    return vault;
  } catch (err) {
    console.warn(
      "[vault] Failed to unlock with the YubiKey:",
      err instanceof Error ? err.message : err,
    );
    console.warn(
      "[vault] Booting LOCKED — dashboards work from local data; bank sync is disabled.\n" +
        "Either plug in the YubiKey and restart, or create a session grant with:\n" +
        "  npm run vault -- grant-session",
    );
    return null;
  }
}

function main() {
  let vault: Vault | null;
  try {
    vault = tryUnlockVault();
  } catch (err) {
    if (err instanceof VaultNotInitializedError) {
      console.warn("[vault]", err.message, "— booting locked.");
      vault = null;
    } else {
      throw err;
    }
  }

  // Initializes the local SQLite file + schema on first boot.
  getDb();

  const host = process.env.HOST ?? "127.0.0.1";
  const app = createApp(vault);
  app.listen(config.port, host, () => {
    console.log(`Finances backend listening on http://${host}:${config.port}`);
    // getter, not the boot-time value: a grant issued later unlocks sync too
    startScheduler(() => ensureVault(app));
  });
}

main();
