import type { Application, NextFunction, Request, Response } from "express";
import { Vault } from "../../vault/vault.js";
import { tryUnlockWithSession } from "../../vault/session.js";

/**
 * Returns the process's unlocked vault, retrying the session grant when there
 * isn't one — so `npm run vault -- grant-session` takes effect on a RUNNING
 * server (the status poll / next Plaid request picks it up; no restart).
 */
export function ensureVault(app: Application): Vault | null {
  const existing = app.locals.vault as Vault | undefined;
  if (existing) return existing;
  const fresh = tryUnlockWithSession();
  if (fresh) {
    app.locals.vault = fresh;
    console.log("[vault] Unlocked at runtime from a session grant — bank sync enabled.");
    return fresh;
  }
  return null;
}

/** Blocks API access whenever the vault isn't unlocked (after a grant retry). */
export function vaultGuard(req: Request, res: Response, next: NextFunction): void {
  if (!ensureVault(req.app)) {
    res.status(503).json({
      error:
        "Vault is not unlocked. Create/refresh a session grant on the host with: npm run vault -- grant-session " +
        "(add --portable when the server runs in Docker) — the running server picks it up automatically.",
    });
    return;
  }
  next();
}
