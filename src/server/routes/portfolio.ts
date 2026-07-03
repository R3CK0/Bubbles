/**
 * server/routes/portfolio.ts — HTTP surface for portfolioService + manual assets.
 * DB-only: mounted before the vault-guarded routers.
 */
import { Router } from "express";
import { z } from "zod";
import { buildContext } from "../../engine/context.js";
import {
  addManualAsset,
  getAllocation,
  getBuildingsPnl,
  getHoldings,
  getManualAssets,
  getPerformance,
  getPortfolioSeries,
  revalueAsset,
  setAllocationTargets,
} from "../../engine/portfolioService.js";
import { getPositionsView, refreshAndRebuild, removePosition, savePosition } from "../../engine/positionsService.js";
import { validateSymbol } from "../../engine/marketDataService.js";
import { manualAssetSchema, valuationSchema, allocationTargetsSchema, positionSchema } from "../contracts.js";
import { requireParam } from "../params.js";

export const portfolioRouter = Router();

const seriesQuery = z.object({
  days: z.coerce.number().int().min(7).max(3650).default(365),
  decompose: z.coerce.boolean().default(false),
});

portfolioRouter.get("/api/portfolio/series", (req, res) => {
  const { days, decompose } = seriesQuery.parse({ days: req.query.days, decompose: req.query.decompose });
  res.json(getPortfolioSeries(buildContext(req.query), days, decompose));
});

portfolioRouter.get("/api/portfolio/holdings", (req, res) => {
  res.json({ holdings: getHoldings(buildContext(req.query)) });
});

portfolioRouter.get("/api/portfolio/allocation", (req, res) => {
  res.json({ allocation: getAllocation(buildContext(req.query)) });
});

portfolioRouter.put("/api/portfolio/targets", (req, res) => {
  const targets = allocationTargetsSchema.parse(req.body);
  setAllocationTargets(targets);
  res.json({ ok: true });
});

const perfQuery = z.object({ days: z.coerce.number().int().min(30).max(3650).default(365) });

portfolioRouter.get("/api/portfolio/performance", (req, res) => {
  const { days } = perfQuery.parse({ days: req.query.days });
  res.json(getPerformance(buildContext(req.query), days));
});

portfolioRouter.get("/api/portfolio/buildings", (req, res) => {
  res.json(getBuildingsPnl(buildContext(req.query)));
});

// ---- manual positions (the user-maintained portfolio state) ----

portfolioRouter.get("/api/positions", (req, res) => {
  res.json({ accounts: getPositionsView(buildContext(req.query)) });
});

portfolioRouter.post("/api/positions", (req, res) => {
  const body = positionSchema.parse(req.body);
  const today = new Date().toISOString().slice(0, 10);
  res.status(201).json({ position: savePosition(body, today) });
});

portfolioRouter.patch("/api/positions/:positionId", (req, res) => {
  const body = positionSchema.parse(req.body);
  const today = new Date().toISOString().slice(0, 10);
  res.json({ position: savePosition({ ...body, positionId: requireParam(req, "positionId") }, today) });
});

portfolioRouter.delete("/api/positions/:positionId", (req, res) => {
  const endDate = new Date().toISOString().slice(0, 10);
  res.json({ removed: removePosition(requireParam(req, "positionId"), endDate) });
});

/** Pull fresh prices and rebuild history — the “Refresh prices” button. */
portfolioRouter.post("/api/positions/refresh", (req, res, next) => {
  const today = new Date().toISOString().slice(0, 10);
  refreshAndRebuild(today)
    .then((result) => res.json(result))
    .catch(next);
});

/** Symbol check for the entry form (Yahoo symbols; TSX needs .TO). */
portfolioRouter.get("/api/positions/validate/:symbol", (req, res, next) => {
  validateSymbol(requireParam(req, "symbol"))
    .then((result) => res.json(result))
    .catch(next);
});

portfolioRouter.get("/api/assets", (_req, res) => {
  res.json({ assets: getManualAssets() });
});

portfolioRouter.post("/api/assets", (req, res) => {
  const body = manualAssetSchema.parse(req.body);
  const today = new Date().toISOString().slice(0, 10);
  res.status(201).json({ asset: addManualAsset({ ...body, today }) });
});

portfolioRouter.post("/api/assets/:assetId/valuations", (req, res) => {
  const body = valuationSchema.parse(req.body);
  revalueAsset(requireParam(req, "assetId"), body.date, body.value, body.source ?? null);
  res.status(201).json({ ok: true });
});
