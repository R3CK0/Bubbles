import { Router } from "express";
import { Vault } from "../../vault/vault.js";
import { isSessionValid, loadSessionMeta } from "../../vault/session.js";

export const vaultStatusRouter = Router();

/** Read-only status. Never returns secret material. */
vaultStatusRouter.get("/api/vault/status", (req, res) => {
  const vault = req.app.locals.vault as Vault | undefined;
  const meta = loadSessionMeta();
  res.json({
    initialized: Vault.isInitialized(),
    unlocked: Boolean(vault),
    session: meta ? { ...meta, valid: isSessionValid(meta) } : null,
  });
});
