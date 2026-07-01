import { config } from "../config.js";
import { Vault } from "./vault.js";
import { VaultSecrets } from "./types.js";
import * as store from "./sessionStore.js";

export type { SessionMeta } from "./sessionStore.js";
export { loadSessionMeta, isSessionValid, revokeGrant as revokeSession } from "./sessionStore.js";

/**
 * Creates (or refreshes) a session grant from an already-unlocked vault
 * (i.e. one just decrypted with the physical YubiKey). Hard-caps requested
 * duration at config.session.maxDays.
 */
export function createSessionGrant(vault: Vault, requestedDays = config.session.defaultDays): store.SessionMeta {
  return store.createGrant(vault.serialize(), requestedDays);
}

/**
 * Attempts to unlock the vault using an existing, non-expired session grant.
 * Returns null (never touches hardware) if there is no valid grant.
 */
export function tryUnlockWithSession(): Vault | null {
  const plaintext = store.openGrant();
  if (!plaintext) return null;
  try {
    const secrets = JSON.parse(plaintext.toString("utf8")) as VaultSecrets;
    return Vault.fromDecryptedSecrets(secrets);
  } catch {
    return null;
  }
}
