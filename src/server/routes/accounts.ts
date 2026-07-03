import { Router } from "express";
import { z } from "zod";
import { vaultGuard } from "../middleware/vaultGuard.js";
import { asyncHandler } from "../asyncHandler.js";
import { requireParam } from "../params.js";
import { classifyAccount, fetchItemAccounts, listItemAccounts } from "../../plaid/accounts.js";
import { REGISTERED_TYPES } from "../../db/repository.js";
import { Vault } from "../../vault/vault.js";

// GET /api/persons moved to routes/persons.ts (DB-only, no vault guard).
export const accountsRouter = Router();
accountsRouter.use(vaultGuard);

/** Locally-stored accounts for one item, including classification state. */
accountsRouter.get("/api/items/:itemId/accounts", (req, res) => {
  res.json({ accounts: listItemAccounts(requireParam(req, "itemId")) });
});

/** Pull the item's full account list from Plaid and upsert it (add-bank wizard step 1). */
accountsRouter.post(
  "/api/items/:itemId/accounts/refresh",
  asyncHandler(async (req, res) => {
    const vault = req.app.locals.vault as Vault;
    const accounts = await fetchItemAccounts(vault, requireParam(req, "itemId"));
    res.json({ accounts });
  }),
);

// `.strict()` rejects unknown keys; every field is optional so a wizard can
// submit a partial patch. `null` explicitly clears a field (e.g. mark joint).
const classifySchema = z
  .object({
    personId: z.string().min(1).nullable().optional(),
    registeredType: z
      .enum(REGISTERED_TYPES as unknown as [string, ...string[]])
      .nullable()
      .optional(),
    purpose: z.string().nullable().optional(),
    tracked: z.boolean().optional(),
    isClosed: z.boolean().optional(),
  })
  .strict();

/** Record what an account is and whether to track it (add-bank wizard step 2). */
accountsRouter.patch(
  "/api/accounts/:accountId",
  (req, res) => {
    const patch = classifySchema.parse(req.body);
    const account = classifyAccount(requireParam(req, "accountId"), patch);
    res.json({ account });
  },
);
