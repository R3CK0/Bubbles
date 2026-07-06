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
import { getPositionsView, refreshAndRebuild, refreshLiveAndRebuild, removePosition, savePosition } from "../../engine/positionsService.js";
import { validateSymbol, searchSymbols } from "../../engine/marketDataService.js";
import { refreshLiveUsdCad } from "../../engine/fxService.js";
import { quoteSymbols, optionChain } from "../../engine/marketData/index.js";
import { latestQuoteTime, quotesBySymbol } from "../../db/repositories/investments.js";
import {
  manualAssetSchema,
  valuationSchema,
  allocationTargetsSchema,
  positionSchema,
  symbolSearchSchema,
  quoteQuerySchema,
  optionChainSchema,
} from "../contracts.js";
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
  const quotes = quotesBySymbol();
  const holdings = getHoldings(buildContext(req.query)).map((h) => ({
    ...h,
    changePct: quotes.get(h.securityId)?.change_pct ?? null,
  }));
  res.json({ holdings });
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
  res.json({ accounts: getPositionsView(buildContext(req.query)), quotesAsOf: latestQuoteTime() });
});

/** Pull a live USD/CAD rate when the position isn't CAD, so its value converts
 *  immediately. Best-effort — never blocks the save from succeeding. */
function ensureFxFor(currency: string | undefined | null, today: string): Promise<unknown> {
  return currency && currency !== "CAD" ? refreshLiveUsdCad(today).catch(() => false) : Promise.resolve();
}

portfolioRouter.post("/api/positions", (req, res, next) => {
  const body = positionSchema.parse(req.body);
  const today = new Date().toISOString().slice(0, 10);
  const position = savePosition(body, today);
  ensureFxFor(body.currency, today).then(() => res.status(201).json({ position })).catch(next);
});

portfolioRouter.patch("/api/positions/:positionId", (req, res, next) => {
  const body = positionSchema.parse(req.body);
  const today = new Date().toISOString().slice(0, 10);
  const position = savePosition({ ...body, positionId: requireParam(req, "positionId") }, today);
  ensureFxFor(body.currency, today).then(() => res.json({ position })).catch(next);
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

/** On-demand live quote refresh (the "● Live" button), scoped to held symbols. */
portfolioRouter.post("/api/positions/quotes/refresh", (_req, res, next) => {
  const today = new Date().toISOString().slice(0, 10);
  refreshLiveAndRebuild(today)
    .then((result) => res.json(result))
    .catch(next);
});

// ---- market data: autocomplete, live quotes, option chains ----

/** Autocomplete for the add-ticker field (equities/ETFs/FX/futures/options/crypto). */
portfolioRouter.get("/api/securities/search", (req, res, next) => {
  const { q } = symbolSearchSchema.parse({ q: req.query.q });
  searchSymbols(q)
    .then((hits) => res.json({ hits }))
    .catch(next);
});

/** Live quotes for a comma-separated symbol list — fetches online, not cached. */
portfolioRouter.get("/api/securities/quote", (req, res, next) => {
  const { symbols } = quoteQuerySchema.parse({ symbols: req.query.symbols });
  const list = symbols.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 20);
  quoteSymbols(list)
    .then((quotes) => res.json({ quotes }))
    .catch(next);
});

/** Option chain for an underlying (expiries + strikes with bid/ask/IV). */
portfolioRouter.get("/api/options/chain", (req, res, next) => {
  const { underlying, expiry } = optionChainSchema.parse({ underlying: req.query.underlying, expiry: req.query.expiry });
  optionChain(underlying, expiry)
    .then((chain) => res.json(chain))
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
