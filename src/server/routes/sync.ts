import { Router } from "express";
import { vaultGuard } from "../middleware/vaultGuard.js";
import { asyncHandler } from "../asyncHandler.js";
import { requireParam } from "../params.js";
import { syncAllItems, syncItemTransactions } from "../../plaid/sync.js";
import { Vault } from "../../vault/vault.js";

export const syncRouter = Router();
syncRouter.use(vaultGuard);

/** Incremental sync for one bank: only pulls what changed since its last stored cursor. */
syncRouter.post(
  "/api/items/:itemId/sync",
  asyncHandler(async (req, res) => {
    const vault = req.app.locals.vault as Vault;
    const result = await syncItemTransactions(vault, requireParam(req, "itemId"));
    res.json(result);
  }),
);

/** Incremental sync across every linked bank. */
syncRouter.post(
  "/api/sync",
  asyncHandler(async (req, res) => {
    const vault = req.app.locals.vault as Vault;
    const result = await syncAllItems(vault);
    res.json(result);
  }),
);
