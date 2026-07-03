/**
 * server/routes/tax.ts — HTTP surface for taxService.
 * POST /api/tax/optimize is the live slider path: side-effect-free apart from
 * the audit row.
 */
import { Router } from "express";
import { z } from "zod";
import { buildContext } from "../../engine/context.js";
import {
  acceptOptimization,
  getEstimates,
  getProfiles,
  getRoom,
  getStrategies,
  runOptimizer,
  updateProfile,
  updateRoom,
} from "../../engine/taxService.js";
import { roomUpdateSchema, taxProfileSchema, optimizeSchema, optimizeAcceptSchema } from "../contracts.js";

export const taxRouter = Router();

const yearQuery = z.object({ year: z.coerce.number().int().min(2026).max(2100).default(new Date().getFullYear()) });

taxRouter.get("/api/tax/estimate", (req, res) => {
  const { year } = yearQuery.parse({ year: req.query.year });
  res.json(getEstimates(buildContext(req.query), year));
});

taxRouter.post("/api/tax/optimize", (req, res) => {
  const body = optimizeSchema.parse(req.body);
  res.json(runOptimizer(buildContext(req.query), body.deployableCash, body.year));
});

taxRouter.post("/api/tax/optimize/accept", (req, res) => {
  const body = optimizeAcceptSchema.parse(req.body);
  res.status(201).json(acceptOptimization(buildContext(req.query), body.deployableCash, body.year, body.planName));
});

taxRouter.get("/api/tax/strategies", (req, res) => {
  const { year } = yearQuery.parse({ year: req.query.year });
  res.json({ strategies: getStrategies(buildContext(req.query), year) });
});

taxRouter.get("/api/tax/room", (req, res) => {
  const { year } = yearQuery.parse({ year: req.query.year });
  res.json({ room: getRoom(buildContext(req.query), year) });
});

taxRouter.put("/api/tax/room", (req, res) => {
  const body = roomUpdateSchema.parse(req.body);
  const asOf = new Date().toISOString().slice(0, 10);
  updateRoom(
    body.rooms.map((r) => ({
      person_id: r.personId,
      account_type: r.accountType,
      tax_year: r.taxYear,
      room_amount: r.roomAmount,
      as_of: asOf,
      source: r.source ?? null,
    })),
  );
  res.json({ ok: true });
});

taxRouter.get("/api/tax/profile", (req, res) => {
  const { year } = yearQuery.parse({ year: req.query.year });
  res.json({ profiles: getProfiles(buildContext(req.query), year) });
});

taxRouter.put("/api/tax/profile", (req, res) => {
  const body = taxProfileSchema.parse(req.body);
  updateProfile({
    person_id: body.personId,
    tax_year: body.taxYear,
    employment_income: body.employmentIncome ?? null,
    withholding_paid: body.withholdingPaid ?? null,
    other_income_json: body.otherIncome === undefined ? null : JSON.stringify(body.otherIncome),
    carryforwards_json: body.carryforwards === undefined ? null : JSON.stringify(body.carryforwards),
    weekly_take_home: body.weeklyTakeHome ?? null,
    updated_at: new Date().toISOString(),
  });
  res.json({ ok: true });
});
