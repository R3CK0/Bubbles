import { Router } from "express";
import { z } from "zod";
import { vaultGuard } from "../middleware/vaultGuard.js";
import { asyncHandler } from "../asyncHandler.js";
import { createLinkToken, exchangePublicToken } from "../../plaid/link.js";
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
