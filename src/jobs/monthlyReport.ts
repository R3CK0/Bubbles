/**
 * jobs/monthlyReport.ts — 1st-of-month report generation.
 */
import { addMonths, monthOf, monthWindow } from "../analytics/calendar.js";
import { buildMonthlyReport } from "../engine/reportService.js";
import { createAlert, reportForPeriod } from "../db/repositories/ops.js";

/** Build last month's report if it doesn't exist yet; raise a ready alert. */
export function runMonthlyReport(today: string): { month: string; created: boolean } {
  const month = addMonths(monthOf(today), -1);
  if (reportForPeriod("monthly", monthWindow(month).start)) return { month, created: false };
  const report = buildMonthlyReport(month);
  createAlert(
    {
      alert_type: "report_ready",
      severity: "info",
      title: `The ${month} household report is ready`,
      body: "Open the Review page for the money-date walkthrough.",
      payload: { reportId: report.report_id, month },
    },
    new Date().toISOString(),
  );
  return { month, created: true };
}
