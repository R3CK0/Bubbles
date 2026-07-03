/**
 * server/routes/networth.ts — HTTP surface for networthService.
 * DB-only: mounted before the vault-guarded routers.
 */
import { Router } from "express";
import { z } from "zod";
import { buildContext } from "../../engine/context.js";
import { getBreakdown, getEmergencyFund, getHero, getNetWorth } from "../../engine/networthService.js";

export const networthRouter = Router();

const daysQuery = z.object({ days: z.coerce.number().int().min(7).max(3650).default(365) });

networthRouter.get("/api/networth", (req, res) => {
  const { days } = daysQuery.parse({ days: req.query.days });
  res.json(getNetWorth(buildContext(req.query), days));
});

networthRouter.get("/api/networth/hero", (req, res) => {
  res.json(getHero(buildContext(req.query)));
});

const breakdownQuery = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

networthRouter.get("/api/networth/breakdown", (req, res) => {
  const { date } = breakdownQuery.parse({ date: req.query.date });
  res.json({ breakdown: getBreakdown(buildContext(req.query), date) });
});

networthRouter.get("/api/networth/emergency-fund", (req, res) => {
  res.json(getEmergencyFund(buildContext(req.query)));
});
