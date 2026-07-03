/**
 * server/routes/goals.ts — HTTP surface for planningService.
 * `/api/goals/solve/preview` is the latency-sensitive drag-to-replan path:
 * side-effect-free by contract.
 */
import { Router } from "express";
import { buildContext } from "../../engine/context.js";
import {
  addScenario,
  approveSolveAsPlan,
  createGoal,
  getActivePlan,
  getGoalsView,
  getScenarios,
  removeLineItem,
  removeScenario,
  saveLineItem,
  solve,
  solveScenario,
  updateGoal,
} from "../../engine/planningService.js";
import {
  goalCreateSchema,
  goalPatchSchema,
  lineItemSchema,
  planApproveSchema,
  scenarioSchema,
  solveOverridesSchema,
} from "../contracts.js";
import { requireParam } from "../params.js";

export const goalsRouter = Router();

goalsRouter.get("/api/goals", (req, res) => {
  res.json(getGoalsView(buildContext(req.query)));
});

goalsRouter.post("/api/goals", (req, res) => {
  const body = goalCreateSchema.parse(req.body);
  res.status(201).json({ goal: createGoal(body) });
});

goalsRouter.patch("/api/goals/:goalId", (req, res) => {
  const body = goalPatchSchema.parse(req.body);
  const goal = updateGoal(requireParam(req, "goalId"), body);
  if (!goal) {
    res.status(404).json({ error: "goal not found" });
    return;
  }
  res.json({ goal });
});

goalsRouter.post("/api/goals/:goalId/items", (req, res) => {
  const body = lineItemSchema.parse(req.body);
  res.status(201).json({ item: saveLineItem(requireParam(req, "goalId"), body) });
});

goalsRouter.delete("/api/goals/items/:lineId", (req, res) => {
  removeLineItem(requireParam(req, "lineId"));
  res.json({ ok: true });
});

goalsRouter.post("/api/goals/solve", (req, res) => {
  const overrides = solveOverridesSchema.parse(req.body ?? {});
  res.json(solve(buildContext(req.query), overrides));
});

/** Drag-to-replan fast path — identical to /solve, kept separate so the
 *  frontend can hammer it without worrying about side effects. */
goalsRouter.post("/api/goals/solve/preview", (req, res) => {
  const overrides = solveOverridesSchema.parse(req.body ?? {});
  res.json(solve(buildContext(req.query), overrides));
});

goalsRouter.post("/api/plans/approve", (req, res) => {
  const body = planApproveSchema.parse(req.body);
  res.status(201).json(approveSolveAsPlan(buildContext(req.query), body.name, body.overrides ?? {}));
});

goalsRouter.get("/api/plans/active", (_req, res) => {
  res.json(getActivePlan() ?? { plan: null, lines: [] });
});

goalsRouter.get("/api/scenarios", (_req, res) => {
  res.json({ scenarios: getScenarios() });
});

goalsRouter.post("/api/scenarios", (req, res) => {
  const body = scenarioSchema.parse(req.body);
  res.status(201).json({ scenario: addScenario(body.name, body.params, body.notes ?? null) });
});

goalsRouter.delete("/api/scenarios/:scenarioId", (req, res) => {
  removeScenario(requireParam(req, "scenarioId"));
  res.json({ ok: true });
});

goalsRouter.post("/api/scenarios/:scenarioId/solve", (req, res) => {
  const result = solveScenario(buildContext(req.query), requireParam(req, "scenarioId"));
  if (!result) {
    res.status(404).json({ error: "scenario not found" });
    return;
  }
  res.json(result);
});
