import type { NextFunction, Request, Response } from "express";
import { Vault } from "../../vault/vault.js";

/** Blocks API access whenever the vault isn't unlocked in memory for this process. */
export function vaultGuard(req: Request, res: Response, next: NextFunction): void {
  const vault = req.app.locals.vault as Vault | undefined;
  if (!vault) {
    res.status(503).json({
      error:
        "Vault is not unlocked in this process. Start the server with the YubiKey present, or create/refresh a " +
        "session grant with: npm run vault -- grant-session",
    });
    return;
  }
  next();
}
