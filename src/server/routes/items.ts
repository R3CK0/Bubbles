import { Router } from "express";
import { vaultGuard } from "../middleware/vaultGuard.js";
import { asyncHandler } from "../asyncHandler.js";
import { requireParam } from "../params.js";
import { getLinkedItems, removeItem } from "../../plaid/items.js";
import { Vault } from "../../vault/vault.js";

export const itemsRouter = Router();
itemsRouter.use(vaultGuard);

itemsRouter.get("/api/items", (_req, res) => {
  res.json({ items: getLinkedItems() });
});

itemsRouter.delete(
  "/api/items/:itemId",
  asyncHandler(async (req, res) => {
    const vault = req.app.locals.vault as Vault;
    await removeItem(vault, requireParam(req, "itemId"));
    res.status(204).end();
  }),
);
