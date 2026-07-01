import fs from "node:fs";
import path from "node:path";
import {
  decryptWithIdentity,
  encryptToRecipient,
  generateYubikeyIdentity,
  GenerateIdentityOptions,
} from "./ageCli.js";
import { config } from "../config.js";
import { emptyVaultSecrets, LinkedItemSecret, PlaidCredentials, VaultSecrets } from "./types.js";
import { resealActiveGrant } from "./sessionStore.js";

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Writes a file atomically (tmp + rename) with owner-only permissions. */
function writeFileSecure(filePath: string, data: string | Buffer) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

export class VaultNotInitializedError extends Error {}
export class VaultLockedError extends Error {}

export class Vault {
  private secrets: VaultSecrets | null;
  readonly recipient: string;

  private constructor(recipient: string, secrets: VaultSecrets | null) {
    this.recipient = recipient;
    this.secrets = secrets;
  }

  static isInitialized(): boolean {
    return (
      fs.existsSync(config.vault.identityPath) &&
      fs.existsSync(config.vault.recipientPath) &&
      fs.existsSync(config.vault.secretsPath)
    );
  }

  /**
   * Provisions the vault: generates (or reuses) a YubiKey-backed PIV identity
   * and creates an empty encrypted secrets file. Requires the YubiKey to be
   * inserted; generation may require a touch depending on policy.
   */
  static init(opts: GenerateIdentityOptions & { existingIdentity?: string; existingRecipient?: string } = {}): void {
    ensureDir(config.vaultDir);

    let identity: string;
    let recipient: string;

    if (opts.existingIdentity && opts.existingRecipient) {
      identity = opts.existingIdentity;
      recipient = opts.existingRecipient;
    } else {
      const generated = generateYubikeyIdentity(opts);
      identity = generated.identity;
      recipient = generated.recipient;
    }

    writeFileSecure(config.vault.identityPath, `${identity}\n`);
    writeFileSecure(config.vault.recipientPath, `${recipient}\n`);

    const empty = emptyVaultSecrets();
    const ciphertext = encryptToRecipient(recipient, Buffer.from(JSON.stringify(empty), "utf8"));
    writeFileSecure(config.vault.secretsPath, ciphertext);
  }

  private static readRecipient(): string {
    if (!fs.existsSync(config.vault.recipientPath)) {
      throw new VaultNotInitializedError(
        "Vault has not been initialized. Run: npm run vault -- init",
      );
    }
    return fs.readFileSync(config.vault.recipientPath, "utf8").trim();
  }

  /**
   * Decrypts the vault directly with the physical YubiKey. Blocks on
   * PIN entry + touch. This is the only path that ever talks to the hardware.
   */
  static unlockWithYubikey(): Vault {
    if (!Vault.isInitialized()) {
      throw new VaultNotInitializedError(
        "Vault has not been initialized. Run: npm run vault -- init",
      );
    }
    const recipient = Vault.readRecipient();
    const ciphertext = fs.readFileSync(config.vault.secretsPath);
    const plaintext = decryptWithIdentity(config.vault.identityPath, ciphertext);
    const secrets = JSON.parse(plaintext.toString("utf8")) as VaultSecrets;
    return new Vault(recipient, secrets);
  }

  /** Used by the session-grant flow, which already produced plaintext secrets. */
  static fromDecryptedSecrets(secrets: VaultSecrets): Vault {
    const recipient = Vault.readRecipient();
    return new Vault(recipient, secrets);
  }

  /** Returns raw plaintext bytes for the current secrets (used to seal a session grant). */
  serialize(): Buffer {
    return Buffer.from(JSON.stringify(this.get()), "utf8");
  }

  get(): VaultSecrets {
    if (!this.secrets) {
      throw new VaultLockedError("Vault secrets are not loaded in memory.");
    }
    return this.secrets;
  }

  /**
   * Re-encrypts current in-memory secrets to the recipient. No hardware needed
   * (encrypting to a YubiKey-backed recipient is pure public-key wrapping).
   * If a session grant is currently active, also re-seals it with the same
   * change so a running unattended container doesn't serve stale secrets
   * (e.g. a newly linked bank) until its next YubiKey-refreshed grant.
   */
  persist(): void {
    const secrets = this.get();
    const plaintext = Buffer.from(JSON.stringify(secrets), "utf8");
    const ciphertext = encryptToRecipient(this.recipient, plaintext);
    writeFileSecure(config.vault.secretsPath, ciphertext);
    resealActiveGrant(plaintext);
  }

  setPlaidCredentials(creds: PlaidCredentials): void {
    this.get().plaid = creds;
    this.persist();
  }

  upsertLinkedItem(item: LinkedItemSecret): void {
    this.get().items[item.itemId] = item;
    this.persist();
  }

  removeLinkedItem(itemId: string): void {
    delete this.get().items[itemId];
    this.persist();
  }

  getAccessToken(itemId: string): string {
    const item = this.get().items[itemId];
    if (!item) throw new Error(`No linked item found for itemId=${itemId}`);
    return item.accessToken;
  }

  /** Wipes secrets from memory (does not affect the encrypted file on disk). */
  lock(): void {
    this.secrets = null;
  }
}
