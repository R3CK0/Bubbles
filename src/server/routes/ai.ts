/**
 * server/routes/ai.ts — HTTP surface for the Gemini expense-review assistant.
 * DB + outbound Gemini only, no vaultGuard (the key lives in .env, not the
 * vault). Suggestion calls are async — errors are forwarded to the error
 * handler explicitly since Express 4 doesn't catch rejected promises.
 */
import { Router } from "express";
import { config } from "../../config.js";
import {
  applySuggestion,
  isAiEnabled,
  reviewNext,
} from "../../engine/aiSuggestionService.js";
import { aiApplySchema, aiSuggestSchema } from "../contracts.js";

export const aiRouter = Router();

aiRouter.get("/api/ai/status", (_req, res) => {
  res.json({ enabled: isAiEnabled(), model: config.gemini.model });
});

/** Review the next unclassified expense (or a given one) — one at a time. */
aiRouter.post("/api/ai/suggest", (req, res, next) => {
  const body = aiSuggestSchema.parse(req.body ?? {});
  reviewNext(body.transactionId)
    .then((result) => res.json(result))
    .catch(next);
});

/** Apply an accepted/overridden suggestion; locks the mapping when allowed. */
aiRouter.post("/api/ai/apply", (req, res) => {
  const body = aiApplySchema.parse(req.body);
  res.json(applySuggestion(body));
});
