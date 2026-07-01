import { Router } from "express";
import { z } from "zod";
import { vaultGuard } from "../middleware/vaultGuard.js";
import { asyncHandler } from "../asyncHandler.js";
import { requireParam } from "../params.js";
import { getCachedBalances, refreshAccountBalances } from "../../plaid/balances.js";
import { Vault } from "../../vault/vault.js";

export const balancesRouter = Router();
balancesRouter.use(vaultGuard);

const querySchema = z.object({ itemId: z.string().optional() });

/** Local cached balances (fast, no Plaid call). Refresh first if you need up-to-the-second numbers. */
balancesRouter.get("/api/balances", (req, res) => {
  const { itemId } = querySchema.parse(req.query);
  res.json({ balances: getCachedBalances(itemId) });
});

/** Live pull from Plaid for one item; updates the local cache. */
balancesRouter.post(
  "/api/accounts/:itemId/refresh",
  asyncHandler(async (req, res) => {
    const vault = req.app.locals.vault as Vault;
    const balances = await refreshAccountBalances(vault, requireParam(req, "itemId"));
    res.json({ balances });
  }),
);
