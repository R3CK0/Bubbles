import { Router } from "express";
import { z } from "zod";
import { vaultGuard } from "../middleware/vaultGuard.js";
import { getTransactions } from "../../plaid/transactions.js";

export const transactionsRouter = Router();
transactionsRouter.use(vaultGuard);

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

const querySchema = z.object({
  startDate: isoDate.optional(),
  endDate: isoDate.optional(),
  accountId: z.string().optional(),
  itemId: z.string().optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

/** Queries locally-synced transactions in a given date range (falls back to all dates if omitted). */
transactionsRouter.get("/api/transactions", (req, res) => {
  const query = querySchema.parse(req.query);
  res.json({ transactions: getTransactions(query) });
});
