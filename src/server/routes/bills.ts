/**
 * server/routes/bills.ts — HTTP surface for recurringService.
 * DB-only: mounted before the vault-guarded routers.
 */
import { Router } from "express";
import { z } from "zod";
import { buildContext } from "../../engine/context.js";
import {
  acceptProposed,
  dismissProposed,
  getBillsCalendar,
  getRegistry,
  getRenewalsAhead,
  removeRecurring,
  saveRecurring,
  setBillCategory,
} from "../../engine/recurringService.js";
import { billCategorySchema, recurringSchema } from "../contracts.js";
import { requireParam } from "../params.js";

export const billsRouter = Router();

billsRouter.get("/api/bills/calendar", (req, res) => {
  res.json(getBillsCalendar(buildContext(req.query)));
});

const statusQuery = z.object({
  status: z.enum(["active", "paused", "ended", "proposed"]).optional(),
});

billsRouter.get("/api/bills/registry", (req, res) => {
  const { status } = statusQuery.parse(req.query);
  res.json({ registry: getRegistry(status) });
});

billsRouter.post("/api/bills", (req, res) => {
  const body = recurringSchema.parse(req.body);
  const today = new Date().toISOString().slice(0, 10);
  res.status(201).json({ recurring: saveRecurring(body, today) });
});

billsRouter.patch("/api/bills/:rpId", (req, res) => {
  const body = recurringSchema.parse(req.body);
  const today = new Date().toISOString().slice(0, 10);
  res.json({ recurring: saveRecurring({ ...body, rpId: requireParam(req, "rpId") }, today) });
});

/** Edit a bill's category — also retargets the merchant mapping (locked or
 *  not) and re-applies it retroactively. */
billsRouter.post("/api/bills/:rpId/category", (req, res) => {
  const body = billCategorySchema.parse(req.body);
  const result = setBillCategory(requireParam(req, "rpId"), body.categoryId, body.retroactiveMonths);
  if (!result) {
    res.status(404).json({ error: "bill not found" });
    return;
  }
  res.json(result);
});

billsRouter.delete("/api/bills/:rpId", (req, res) => {
  res.json({ removed: removeRecurring(requireParam(req, "rpId")) });
});

billsRouter.post("/api/bills/:rpId/accept", (req, res) => {
  res.json({ accepted: acceptProposed(requireParam(req, "rpId")) });
});

billsRouter.post("/api/bills/:rpId/dismiss", (req, res) => {
  res.json({ dismissed: dismissProposed(requireParam(req, "rpId")) });
});

const renewalsQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

billsRouter.get("/api/bills/renewals", (req, res) => {
  const { days } = renewalsQuery.parse({ days: req.query.days });
  const today = new Date().toISOString().slice(0, 10);
  res.json({ renewals: getRenewalsAhead(today, days) });
});
