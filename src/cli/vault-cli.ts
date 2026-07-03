#!/usr/bin/env node
import { Command } from "commander";
import { checkAgeToolsInstalled, listYubikeyIdentities } from "../vault/ageCli.js";
import { Vault } from "../vault/vault.js";
import { config } from "../config.js";
import { createSessionGrant, isSessionValid, loadSessionMeta, revokeSession, tryUnlockWithSession } from "../vault/session.js";

const program = new Command();
program.name("vault").description("Manage the YubiKey-gated secrets vault for the Finances backend.");

/** Prints a clean error message (instead of a raw stack trace) and sets a non-zero exit code. */
function action(fn: (...args: any[]) => void) {
  return (...args: any[]) => {
    try {
      fn(...args);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  };
}

program
  .command("init")
  .description("Provision the vault: generates (or reuses) a YubiKey PIV identity and an empty encrypted secrets file.")
  .option("--slot <n>", "PIV slot number to use (age-plugin-yubikey will prompt if omitted)", (v) => Number(v))
  .option("--touch-policy <policy>", "always | cached | never", "always")
  .option("--pin-policy <policy>", "always | once | never", "once")
  .option("--name <name>", "Label stored on the YubiKey for this identity", "finances-vault")
  .option("--existing-identity <identity>", "Reuse an existing AGE-PLUGIN-YUBIKEY-... identity instead of generating one")
  .option("--existing-recipient <recipient>", "Recipient (age1yubikey1...) matching --existing-identity")
  .option("--force", "Overwrite an existing vault (DESTROYS any stored Plaid keys / bank tokens)", false)
  .action(action((opts) => {
    checkAgeToolsInstalled();

    if (Vault.isInitialized() && !opts.force) {
      console.error(
        `Vault already initialized at ${config.vaultDir}. Re-running init would overwrite it and destroy any ` +
          `stored Plaid credentials and bank access tokens. Pass --force if you really mean to do this.`,
      );
      process.exitCode = 1;
      return;
    }

    console.log("Insert your YubiKey and follow any prompts (PIN setup / touch)...");
    Vault.init({
      slot: opts.slot,
      touchPolicy: opts.touchPolicy,
      pinPolicy: opts.pinPolicy,
      name: opts.name,
      existingIdentity: opts.existingIdentity,
      existingRecipient: opts.existingRecipient,
    });
    console.log(`Vault initialized at ${config.vaultDir}`);
    console.log("Next: npm run vault -- set-plaid-keys --client-id <id> --secret <secret> --env sandbox");
  }));

program
  .command("status")
  .description("Show vault initialization and session-grant status. Never touches the YubiKey.")
  .action(action(() => {
    const initialized = Vault.isInitialized();
    console.log(`Vault initialized: ${initialized}`);
    if (!initialized) return;

    const meta = loadSessionMeta();
    if (!meta) {
      console.log("Session grant: none. The server will require the physical YubiKey at startup.");
      return;
    }
    const valid = isSessionValid(meta);
    console.log(`Session grant: created ${meta.createdAt}, expires ${meta.expiresAt} (max ${meta.maxDays}d)`);
    console.log(`Session valid: ${valid}`);
    if (valid) {
      const usable = tryUnlockWithSession() !== null;
      console.log(`Session key retrievable (Keychain/file): ${usable}`);
    }
  }));

program
  .command("grant-session")
  .description(
    `Unlocks the vault with the physical YubiKey once, then issues a temporary session grant (max ${config.session.maxDays} days) ` +
      "so the server can run unattended. Must be re-run with the YubiKey to refresh before it expires.",
  )
  .option("--days <n>", `Requested validity in days (capped at ${config.session.maxDays})`, (v) => Number(v), config.session.defaultDays)
  .option(
    "--portable",
    "Also write the session key to data/vault/session.key (0600) so a Docker container sharing ./data can use the grant. Required for docker compose on a macOS host.",
    false,
  )
  .action(action((opts) => {
    if (!Vault.isInitialized()) {
      console.error("Vault has not been initialized. Run: npm run vault -- init");
      process.exitCode = 1;
      return;
    }
    console.log("Touch your YubiKey to unlock the vault and issue the session grant...");
    const vault = Vault.unlockWithYubikey();
    const meta = createSessionGrant(vault, opts.days, opts.portable);
    console.log(`Session grant issued. Valid until ${meta.expiresAt} (${meta.maxDays} days).`);
    if (opts.portable) console.log("Portable: the session key is on disk next to the grant, so the Docker container can use it.");
    console.log("A running server (local or container) picks the grant up automatically within a minute — no restart needed.");
  }));

program
  .command("revoke-session")
  .description("Immediately invalidates any active session grant. Does not require the YubiKey.")
  .action(action(() => {
    revokeSession();
    console.log("Session grant revoked. The server will require the physical YubiKey (or a new grant) to start.");
  }));

program
  .command("set-plaid-keys")
  .description("Stores your Plaid client_id/secret in the vault. Requires the physical YubiKey.")
  .requiredOption("--client-id <id>", "Plaid client_id")
  .requiredOption("--secret <secret>", "Plaid secret")
  .option("--env <env>", "sandbox | development | production", "sandbox")
  .action(action((opts) => {
    if (!Vault.isInitialized()) {
      console.error("Vault has not been initialized. Run: npm run vault -- init");
      process.exitCode = 1;
      return;
    }
    if (!["sandbox", "development", "production"].includes(opts.env)) {
      console.error("--env must be one of: sandbox, development, production");
      process.exitCode = 1;
      return;
    }
    console.log("Touch your YubiKey to unlock the vault...");
    const vault = Vault.unlockWithYubikey();
    vault.setPlaidCredentials({ clientId: opts.clientId, secret: opts.secret, env: opts.env });
    console.log(`Plaid credentials stored for env=${opts.env}.`);
  }));

program
  .command("list-identities")
  .description("Lists YubiKey PIV identities visible to age-plugin-yubikey (debug helper).")
  .action(action(() => {
    console.log(listYubikeyIdentities());
  }));

program.parse();
