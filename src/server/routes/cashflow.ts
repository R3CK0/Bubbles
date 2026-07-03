/**
 * server/routes/cashflow.ts — HTTP surface for cashflowService.
 * DB-only reads: no vaultGuard (the vault gates Plaid, not local analytics).
 */
import { Router } from "express";
import { z } from "zod";
import { buildContext } from "../../engine/context.js";
import {
  getAccountFlows,
  getCashflowSummary,
  getCategoryDrilldown,
  getExcludedSummary,
  getFlowLayout,
  getFluxMatrix,
  getIncomeBreakdown,
  getSankey,
  saveFlowLayout,
} from "../../engine/cashflowService.js";
import { flowLayoutSchema } from "../contracts.js";
import { requireParam } from "../params.js";

export const cashflowRouter = Router();

cashflowRouter.get("/api/cashflow/summary", (req, res) => {
  res.json(getCashflowSummary(buildContext(req.query)));
});

cashflowRouter.get("/api/cashflow/sankey", (req, res) => {
  res.json(getSankey(buildContext(req.query)));
});

/** Money-in drill-down: income sources with the accounts the money landed in. */
cashflowRouter.get("/api/cashflow/income", (req, res) => {
  res.json(getIncomeBreakdown(buildContext(req.query)));
});

/** Account Flows: the month's transfers between own accounts, aggregated. */
cashflowRouter.get("/api/cashflow/transfers", (req, res) => {
  res.json(getAccountFlows(buildContext(req.query)));
});

/** Persisted card positions for the Account Flows diagram. */
cashflowRouter.get("/api/cashflow/transfers/layout", (_req, res) => {
  res.json({ layout: getFlowLayout() });
});

cashflowRouter.put("/api/cashflow/transfers/layout", (req, res) => {
  const body = flowLayoutSchema.parse(req.body);
  saveFlowLayout(body.layout);
  res.json({ ok: true });
});

/** What the budget deliberately ignores this month: reimbursed + goal spend. */
cashflowRouter.get("/api/cashflow/excluded", (req, res) => {
  res.json(getExcludedSummary(buildContext(req.query)));
});

const fluxQuery = z.object({ months: z.coerce.number().int().min(1).max(36).default(12) });

cashflowRouter.get("/api/cashflow/flux", (req, res) => {
  const { months } = fluxQuery.parse({ months: req.query.months });
  res.json(getFluxMatrix(buildContext(req.query), months));
});

cashflowRouter.get("/api/cashflow/category/:categoryId", (req, res) => {
  res.json(getCategoryDrilldown(buildContext(req.query), requireParam(req, "categoryId")));
});
