/**
 * engine/reportService.ts — monthly report assembly + Review story deck.
 * data_json is assembled from deterministic service calls; content_md renders
 * from a fixed template. (A later agent may rewrite prose; data is immutable.)
 */
import { addMonths, monthWindow, roundCents } from "../analytics/index.js";
import type { EngineContext } from "./context.js";
import { getCashflowSummary } from "./cashflowService.js";
import { getBudgetView, getVarianceNarratives } from "./budgetService.js";
import { getGoalsView } from "./planningService.js";
import { getHero } from "./networthService.js";
import { getBillsCalendar } from "./recurringService.js";
import { getOpenAlerts } from "./alertsService.js";
import { listPersons } from "../db/repository.js";
import {
  addDecision,
  getReport,
  listDecisions,
  listReports,
  reportForPeriod,
  saveReport,
  type DecisionRow,
  type ReportRow,
} from "../db/repositories/ops.js";

function ctxForMonth(month: string): EngineContext {
  const persons = listPersons();
  return {
    lens: "combined",
    month,
    range: monthWindow(month),
    persons,
    personNames: new Map(persons.map((p) => [p.person_id, p.display_name])),
    today: new Date().toISOString().slice(0, 10),
  };
}

export interface MonthlyReportData {
  month: string;
  cashflow: ReturnType<typeof getCashflowSummary>;
  topVariances: ReturnType<typeof getVarianceNarratives>;
  goals: { name: string; progress: number; feasible: string }[];
  netWorth: { current: number; monthDelta: number | null };
  nextMonthBills: number;
  openAlerts: number;
}

function renderMarkdown(d: MonthlyReportData): string {
  const lines = [
    `# Household report — ${d.month}`,
    ``,
    `## The month in one line`,
    `In: **$${d.cashflow.income.toFixed(0)}** · Out: **$${d.cashflow.spend.toFixed(0)}** · Net: **$${d.cashflow.net.toFixed(0)}**`,
    ``,
    `## Net worth`,
    `Now **$${d.netWorth.current.toFixed(0)}**${d.netWorth.monthDelta !== null ? ` (${d.netWorth.monthDelta >= 0 ? "+" : ""}$${d.netWorth.monthDelta.toFixed(0)} this month)` : ""}.`,
    ``,
    `## Where the money went`,
    ...d.cashflow.byCategory.slice(0, 8).map((c) => `- ${c.name}: $${c.amount.toFixed(0)}`),
    ``,
  ];
  if (d.topVariances.length > 0) {
    lines.push(`## Worth discussing`);
    for (const v of d.topVariances) {
      lines.push(`- **${v.name}** over by $${v.variance.toFixed(0)}${v.drivers[0] ? ` — ${v.drivers[0].detail}` : ""}`);
    }
    lines.push("");
  }
  lines.push(`## Goals`);
  for (const g of d.goals) {
    lines.push(`- ${g.name}: ${(g.progress * 100).toFixed(0)}% funded (${g.feasible === "yes" ? "on track" : g.feasible})`);
  }
  lines.push("", `## Ahead`, `Next month's known bills total $${d.nextMonthBills.toFixed(0)}. Open alerts: ${d.openAlerts}.`);
  return lines.join("\n");
}

export function buildMonthlyReport(month: string): ReportRow {
  const ctx = ctxForMonth(month);
  const goalsView = getGoalsView(ctx);
  const verdicts = new Map(goalsView.solve.perGoal.map((g) => [g.goalId, g.feasible]));
  const nextMonth = getBillsCalendar(ctxForMonth(addMonths(month, 1)));

  const data: MonthlyReportData = {
    month,
    cashflow: getCashflowSummary(ctx),
    topVariances: getVarianceNarratives(ctx, 5),
    goals: goalsView.goals.map((g) => ({
      name: g.name,
      progress: g.progress,
      feasible: verdicts.get(g.goal_id) ?? "yes",
    })),
    netWorth: (({ current, monthDelta }) => ({ current, monthDelta }))(getHero(ctx)),
    nextMonthBills: roundCents(nextMonth.days.reduce((s, d) => s + d.total, 0)),
    openAlerts: getOpenAlerts().length,
  };

  const window = monthWindow(month);
  return saveReport({
    report_type: "monthly",
    period_start: window.start,
    period_end: window.end,
    content_md: renderMarkdown(data),
    data_json: JSON.stringify(data),
    created_at: new Date().toISOString(),
  });
}

export interface ReviewSlide {
  kind: "cashflow" | "categories" | "variances" | "goals" | "networth" | "ahead" | "decisions";
  title: string;
  data: unknown;
}

/** Story-mode deck: archived report data reshaped into ordered slides. */
export function getReviewDeck(month: string): { month: string; slides: ReviewSlide[] } {
  let report = reportForPeriod("monthly", monthWindow(month).start);
  if (!report) report = buildMonthlyReport(month);
  const d = JSON.parse(report.data_json ?? "{}") as MonthlyReportData;
  return {
    month,
    slides: [
      { kind: "cashflow", title: "What came in, what went out", data: d.cashflow },
      { kind: "categories", title: "Where it went", data: d.cashflow.byCategory },
      { kind: "variances", title: "Worth discussing", data: d.topVariances },
      { kind: "goals", title: "Goal progress", data: d.goals },
      { kind: "networth", title: "Net worth", data: d.netWorth },
      { kind: "ahead", title: "The month ahead", data: { bills: d.nextMonthBills, alerts: d.openAlerts } },
      { kind: "decisions", title: "Decisions", data: listDecisions().slice(0, 5) },
    ],
  };
}

export function getReports(type?: ReportRow["report_type"]) {
  return listReports(type);
}

export function getReportById(reportId: string): ReportRow | undefined {
  return getReport(reportId);
}

export function captureDecision(input: { date: string; title: string; body?: string | null; links?: unknown }): DecisionRow {
  return addDecision({
    date: input.date,
    title: input.title,
    body: input.body ?? null,
    links_json: input.links === undefined ? null : JSON.stringify(input.links),
  });
}

export function getDecisions(): DecisionRow[] {
  return listDecisions();
}
