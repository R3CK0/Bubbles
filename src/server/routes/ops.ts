/**
 * server/routes/ops.ts — alerts, reports, review deck, decisions, settings,
 * job triggers, and the one-request /api/overview aggregate.
 */
import { Router } from "express";
import { z } from "zod";
import { buildContext } from "../../engine/context.js";
import { ackAlert, getOpenAlerts } from "../../engine/alertsService.js";
import {
  buildMonthlyReport,
  captureDecision,
  getDecisions,
  getReportById,
  getReports,
  getReviewDeck,
} from "../../engine/reportService.js";
import { getHero } from "../../engine/networthService.js";
import { getCashflowSummary } from "../../engine/cashflowService.js";
import { getGoalsView } from "../../engine/planningService.js";
import { getBillsCalendar } from "../../engine/recurringService.js";
import { uncategorizedCount } from "../../db/repositories/budgeting.js";
import { getSetting, lastSuccessfulRun, setSetting } from "../../db/repositories/ops.js";
import { runNightly } from "../../jobs/nightly.js";
import { addDays } from "../../analytics/calendar.js";
import { decisionSchema, settingsSchema } from "../contracts.js";
import { requireParam } from "../params.js";
import { ensureVault } from "../middleware/vaultGuard.js";

export const opsRouter = Router();

// ---- overview: the Overview page in one request ----
opsRouter.get("/api/overview", (req, res) => {
  const ctx = buildContext(req.query);
  const goalsView = getGoalsView(ctx);
  const verdicts = new Map(goalsView.solve.perGoal.map((g) => [g.goalId, g.feasible]));
  const bills = getBillsCalendar(ctx);
  const week = addDays(ctx.today, 7);
  res.json({
    hero: getHero(ctx),
    cashflow: getCashflowSummary(ctx),
    goals: goalsView.goals.map((g) => ({
      goalId: g.goal_id,
      name: g.name,
      progress: g.progress,
      feasible: verdicts.get(g.goal_id) ?? "yes",
    })),
    next7Days: bills.days.filter((d) => d.date >= ctx.today && d.date <= week),
    lowWindows: bills.lowWindows,
    alerts: getOpenAlerts(),
    uncategorized: uncategorizedCount(),
    lastSync: lastSuccessfulRun()?.started_at ?? null,
  });
});

// ---- alerts ----
opsRouter.get("/api/alerts", (_req, res) => {
  res.json({ alerts: getOpenAlerts() });
});

const ackSchema = z.object({ personId: z.string().min(1).nullable().optional() }).strict();

opsRouter.post("/api/alerts/:alertId/ack", (req, res) => {
  const body = ackSchema.parse(req.body ?? {});
  res.json({ acknowledged: ackAlert(requireParam(req, "alertId"), body.personId ?? null) });
});

// ---- reports & review ----
opsRouter.get("/api/reports", (req, res) => {
  const type = req.query.type as "monthly" | "quarterly" | "annual" | "adhoc" | undefined;
  res.json({ reports: getReports(type) });
});

opsRouter.get("/api/reports/:reportId", (req, res) => {
  const report = getReportById(requireParam(req, "reportId"));
  if (!report) {
    res.status(404).json({ error: "report not found" });
    return;
  }
  res.json({ report });
});

const monthParam = z.string().regex(/^\d{4}-\d{2}$/);

opsRouter.post("/api/reports/monthly/:month/generate", (req, res) => {
  const month = monthParam.parse(requireParam(req, "month"));
  res.status(201).json({ report: buildMonthlyReport(month) });
});

opsRouter.get("/api/review/:month", (req, res) => {
  const month = monthParam.parse(requireParam(req, "month"));
  res.json(getReviewDeck(month));
});

// ---- decisions ----
opsRouter.get("/api/decisions", (_req, res) => {
  res.json({ decisions: getDecisions() });
});

opsRouter.post("/api/decisions", (req, res) => {
  const body = decisionSchema.parse(req.body);
  res.status(201).json({ decision: captureDecision(body) });
});

// ---- settings ----
const SETTING_KEYS = ["buffer_floor", "buffer_target", "base_currency", "allocation_targets"] as const;

opsRouter.get("/api/settings", (_req, res) => {
  const settings: Record<string, string | null> = {};
  for (const key of SETTING_KEYS) settings[key] = getSetting(key);
  res.json({ settings });
});

opsRouter.put("/api/settings", (req, res) => {
  const body = settingsSchema.parse(req.body);
  for (const [key, value] of Object.entries(body)) {
    if (value !== undefined) setSetting(key, String(value));
  }
  res.json({ ok: true });
});

// ---- manual job trigger (the “Sync now” button) ----
opsRouter.post("/api/jobs/nightly/run", (req, res, next) => {
  const vault = ensureVault(req.app);
  runNightly(vault)
    .then((result) => res.json(result))
    .catch(next);
});
