import { Router } from "express";
import { Vault } from "../../vault/vault.js";
import { isSessionValid, loadSessionMeta } from "../../vault/session.js";
import { ensureVault } from "../middleware/vaultGuard.js";

export const vaultStatusRouter = Router();

/** Status (never returns secret material). Retries the session grant, so the
 *  web app's poll auto-unlocks a running server after `grant-session`. */
vaultStatusRouter.get("/api/vault/status", (req, res) => {
  const vault = ensureVault(req.app);
  const meta = loadSessionMeta();
  res.json({
    initialized: Vault.isInitialized(),
    unlocked: Boolean(vault),
    session: meta ? { ...meta, valid: isSessionValid(meta) } : null,
  });
});
