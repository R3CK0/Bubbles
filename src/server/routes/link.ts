import { Router } from "express";
import { z } from "zod";
import { vaultGuard } from "../middleware/vaultGuard.js";
import { asyncHandler } from "../asyncHandler.js";
import { requireParam } from "../params.js";
import { createLinkToken, createUpdateLinkToken, exchangePublicToken } from "../../plaid/link.js";
import { Vault } from "../../vault/vault.js";

export const linkRouter = Router();
linkRouter.use(vaultGuard);

const tokenCreateSchema = z.object({ clientUserId: z.string().min(1) });

linkRouter.post(
  "/api/link/token",
  asyncHandler(async (req, res) => {
    const { clientUserId } = tokenCreateSchema.parse(req.body);
    const vault = req.app.locals.vault as Vault;
    const linkToken = await createLinkToken(vault, clientUserId);
    res.json({ linkToken });
  }),
);

const exchangeSchema = z.object({ publicToken: z.string().min(1) });

linkRouter.post(
  "/api/link/exchange",
  asyncHandler(async (req, res) => {
    const { publicToken } = exchangeSchema.parse(req.body);
    const vault = req.app.locals.vault as Vault;
    const result = await exchangePublicToken(vault, publicToken);
    res.json(result);
  }),
);

/**
 * Update-mode Link token to repair an item that needs re-authentication.
 * The frontend opens Plaid Link with this token; on success the same item is
 * fixed in place (no public-token exchange, no duplicates) and a normal sync
 * resumes.
 */
linkRouter.post(
  "/api/items/:itemId/reconnect",
  asyncHandler(async (req, res) => {
    const vault = req.app.locals.vault as Vault;
    const linkToken = await createUpdateLinkToken(vault, requireParam(req, "itemId"));
    res.json({ linkToken });
  }),
);
