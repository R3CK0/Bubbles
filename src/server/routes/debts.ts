/**
 * server/routes/debts.ts — HTTP surface for debtService.
 * DB-only: mounted before the vault-guarded routers.
 */
import { Router } from "express";
import { z } from "zod";
import { buildContext } from "../../engine/context.js";
import {
  createDebt,
  getDebtOverview,
  getLongTermDebtView,
  getPayoffPlan,
  getShortTermDebtView,
  getShortTermHistory,
  getStrategyComparison,
  setDebtStatement,
  updateDebt,
} from "../../engine/debtService.js";
import { debtCreateSchema, debtPatchSchema, debtStatementSchema } from "../contracts.js";
import { requireParam } from "../params.js";

export const debtsRouter = Router();

debtsRouter.get("/api/debts", (req, res) => {
  res.json(getDebtOverview(buildContext(req.query)));
});

debtsRouter.get("/api/debts/short-term", (req, res) => {
  res.json(getShortTermDebtView(buildContext(req.query)));
});

const historyQuery = z.object({ months: z.coerce.number().int().min(1).max(36).default(12) });

/** Monthly spend / payments / interest for the short-term bar chart. */
debtsRouter.get("/api/debts/short-term/history", (req, res) => {
  const { months } = historyQuery.parse({ months: req.query.months });
  res.json(getShortTermHistory(buildContext(req.query), months));
});

debtsRouter.get("/api/debts/long-term", (req, res) => {
  res.json(getLongTermDebtView(buildContext(req.query)));
});

const payoffQuery = z.object({
  strategy: z.enum(["avalanche", "snowball"]).default("avalanche"),
  extra: z.coerce.number().min(0).default(0),
});

debtsRouter.get("/api/debts/payoff", (req, res) => {
  const { strategy, extra } = payoffQuery.parse({ strategy: req.query.strategy, extra: req.query.extra });
  res.json(getPayoffPlan(buildContext(req.query), strategy, extra));
});

debtsRouter.get("/api/debts/compare", (req, res) => {
  const { extra } = payoffQuery.parse({ extra: req.query.extra });
  res.json(getStrategyComparison(buildContext(req.query), extra));
});

debtsRouter.post("/api/debts", (req, res) => {
  const body = debtCreateSchema.parse(req.body);
  res.status(201).json({ debt: createDebt(body) });
});

debtsRouter.patch("/api/debts/:debtId", (req, res) => {
  const body = debtPatchSchema.parse(req.body);
  const debt = updateDebt(requireParam(req, "debtId"), body);
  if (!debt) {
    res.status(404).json({ error: "debt not found" });
    return;
  }
  res.json({ debt });
});

debtsRouter.put("/api/debts/:debtId/statement", (req, res) => {
  const body = debtStatementSchema.parse(req.body);
  const statement = setDebtStatement(requireParam(req, "debtId"), body);
  if (!statement) {
    res.status(404).json({ error: "debt not found" });
    return;
  }
  res.json({ statement });
});
