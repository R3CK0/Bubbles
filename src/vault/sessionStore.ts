import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import os from "node:os";
import { config } from "../config.js";

/**
 * Low-level session-grant storage: sealing/unsealing the vault snapshot with
 * an ephemeral session key, and where that key itself lives (Keychain/file).
 *
 * Deliberately has NO dependency on vault.ts (Vault re-imports this module to
 * keep the session blob in sync on every persist() — importing the other way
 * would create a cycle).
 */

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export interface SessionMeta {
  createdAt: string;
  expiresAt: string;
  maxDays: number;
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function writeFileSecure(filePath: string, data: string | Buffer) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function isMacOS(): boolean {
  return os.platform() === "darwin";
}

function keychainStore(secretBase64: string): boolean {
  if (!isMacOS()) return false;
  const result = spawnSync(
    "security",
    [
      "add-generic-password",
      "-a",
      config.vault.sessionKeyAccount,
      "-s",
      config.vault.sessionKeyServiceName,
      "-w",
      secretBase64,
      "-U",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  return result.status === 0;
}

function keychainRetrieve(): string | null {
  if (!isMacOS()) return null;
  const result = spawnSync(
    "security",
    ["find-generic-password", "-a", config.vault.sessionKeyAccount, "-s", config.vault.sessionKeyServiceName, "-w"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) return null;
  return result.stdout.toString("utf8").trim();
}

function keychainDelete(): void {
  if (!isMacOS()) return;
  spawnSync(
    "security",
    ["delete-generic-password", "-a", config.vault.sessionKeyAccount, "-s", config.vault.sessionKeyServiceName],
    { stdio: "ignore" },
  );
}

function storeSessionKey(key: Buffer, portable = false): void {
  const b64 = key.toString("base64");
  if (portable) {
    // Docker shares ./data with a Linux container that cannot read the macOS
    // Keychain — the session key must live next to the sealed blob as a 0600
    // file. Also store it in the Keychain (same key) so host boots keep
    // preferring the safer copy.
    writeFileSecure(config.vault.sessionKeyFallbackPath, b64);
    keychainStore(b64);
    return;
  }
  const storedInKeychain = keychainStore(b64);
  if (storedInKeychain) {
    if (fs.existsSync(config.vault.sessionKeyFallbackPath)) {
      fs.rmSync(config.vault.sessionKeyFallbackPath, { force: true });
    }
    return;
  }
  // Non-macOS (e.g. the Linux container image): there's no OS keychain reachable,
  // so the session key lives in a 0600 file instead. This is expected there, not
  // a degraded fallback the way it would be on a Mac with Keychain available.
  if (!isMacOS()) {
    writeFileSecure(config.vault.sessionKeyFallbackPath, b64);
    return;
  }
  // eslint-disable-next-line no-console
  console.warn(
    "[vault] macOS Keychain unavailable; falling back to storing the session key in a 0600 file. " +
      "This is less secure than Keychain storage.",
  );
  writeFileSecure(config.vault.sessionKeyFallbackPath, b64);
}

function retrieveSessionKey(): Buffer | null {
  const fromKeychain = keychainRetrieve();
  if (fromKeychain) return Buffer.from(fromKeychain, "base64");
  if (fs.existsSync(config.vault.sessionKeyFallbackPath)) {
    return Buffer.from(fs.readFileSync(config.vault.sessionKeyFallbackPath, "utf8").trim(), "base64");
  }
  return null;
}

function aesGcmEncrypt(key: Buffer, plaintext: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}

function aesGcmDecrypt(key: Buffer, blob: Buffer): Buffer {
  const iv = blob.subarray(0, IV_LENGTH);
  const authTag = blob.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = blob.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function loadSessionMeta(): SessionMeta | null {
  if (!fs.existsSync(config.vault.sessionMetaPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(config.vault.sessionMetaPath, "utf8")) as SessionMeta;
  } catch {
    return null;
  }
}

export function isSessionValid(meta: SessionMeta | null = loadSessionMeta()): boolean {
  if (!meta) return false;
  return new Date(meta.expiresAt).getTime() > Date.now();
}

/** Seals plaintext with a brand-new session key and writes both the blob and the grant metadata. */
export function createGrant(plaintext: Buffer, requestedDays: number, portable = false): SessionMeta {
  const days = Math.max(1, Math.min(requestedDays, config.session.maxDays));
  const sessionKey = crypto.randomBytes(32);
  const sealed = aesGcmEncrypt(sessionKey, plaintext);
  writeFileSecure(config.vault.sessionSecretsPath, sealed);

  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + days * 24 * 60 * 60 * 1000);
  const meta: SessionMeta = {
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    maxDays: days,
  };
  writeFileSecure(config.vault.sessionMetaPath, JSON.stringify(meta, null, 2));
  storeSessionKey(sessionKey, portable);
  return meta;
}

/** Decrypts the sealed session blob, if a valid grant and retrievable key exist. */
export function openGrant(): Buffer | null {
  const meta = loadSessionMeta();
  if (!isSessionValid(meta)) return null;
  if (!fs.existsSync(config.vault.sessionSecretsPath)) return null;

  const sessionKey = retrieveSessionKey();
  if (!sessionKey) return null;

  try {
    const blob = fs.readFileSync(config.vault.sessionSecretsPath);
    return aesGcmDecrypt(sessionKey, blob);
  } catch {
    return null;
  }
}

/**
 * Re-seals updated plaintext under the CURRENT session grant's existing key,
 * without changing its expiry. No-op (returns false) if there's no active
 * grant or its key isn't retrievable — callers should treat that as "nothing
 * to keep in sync," not an error, since the durable vault write already
 * succeeded by the time this runs.
 */
export function resealActiveGrant(plaintext: Buffer): boolean {
  const meta = loadSessionMeta();
  if (!isSessionValid(meta)) return false;
  const sessionKey = retrieveSessionKey();
  if (!sessionKey) return false;
  const sealed = aesGcmEncrypt(sessionKey, plaintext);
  writeFileSecure(config.vault.sessionSecretsPath, sealed);
  return true;
}

export function revokeGrant(): void {
  for (const file of [config.vault.sessionSecretsPath, config.vault.sessionMetaPath, config.vault.sessionKeyFallbackPath]) {
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  }
  keychainDelete();
}
