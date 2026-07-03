/**
 * db/repositories/ops.ts — data access for alerts, reports, decisions,
 * sync runs, and household settings.
 */
import { createHash, randomUUID } from "node:crypto";
import { getDb } from "../db.js";

// ---- settings ----

export function getSetting(key: string): string | null {
  const row = getDb().prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(key, value);
}

export function getNumberSetting(key: string, fallback: number): number {
  const raw = getSetting(key);
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

// ---- alerts ----

export interface AlertRow {
  alert_id: string;
  alert_type: string;
  severity: "info" | "warning" | "critical";
  title: string;
  body: string | null;
  payload_json: string | null;
  created_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
}

/**
 * Create an alert unless an unacknowledged alert with the same type+payload
 * hash already exists within `dedupeDays` — nightly re-runs must not stack
 * duplicates.
 */
export function createAlert(
  input: Pick<AlertRow, "alert_type" | "severity" | "title" | "body"> & { payload?: unknown },
  now: string,
  dedupeDays = 7,
): AlertRow | null {
  const payloadJson = input.payload === undefined ? null : JSON.stringify(input.payload);
  const hash = createHash("sha256")
    .update(`${input.alert_type}|${payloadJson ?? input.title}`)
    .digest("hex")
    .slice(0, 16);

  const cutoff = new Date(new Date(now).getTime() - dedupeDays * 86_400_000).toISOString();
  const dupe = getDb()
    .prepare(
      `SELECT 1 FROM alerts WHERE alert_type = ? AND acknowledged_at IS NULL AND created_at >= ?
         AND COALESCE(json_extract(payload_json, '$._hash'), '') = ?`,
    )
    .get(input.alert_type, cutoff, hash);
  if (dupe) return null;

  const payload = { ...(input.payload as object | undefined), _hash: hash };
  const row: AlertRow = {
    alert_id: randomUUID(),
    alert_type: input.alert_type,
    severity: input.severity,
    title: input.title,
    body: input.body,
    payload_json: JSON.stringify(payload),
    created_at: now,
    acknowledged_at: null,
    acknowledged_by: null,
  };
  getDb()
    .prepare(
      `INSERT INTO alerts (alert_id, alert_type, severity, title, body, payload_json, created_at)
       VALUES (@alert_id, @alert_type, @severity, @title, @body, @payload_json, @created_at)`,
    )
    .run(row);
  return row;
}

export function openAlerts(): AlertRow[] {
  return getDb()
    .prepare(`SELECT * FROM alerts WHERE acknowledged_at IS NULL ORDER BY created_at DESC`)
    .all() as AlertRow[];
}

export function acknowledgeAlert(alertId: string, personId: string | null, now: string): boolean {
  return (
    getDb()
      .prepare(`UPDATE alerts SET acknowledged_at = ?, acknowledged_by = ? WHERE alert_id = ? AND acknowledged_at IS NULL`)
      .run(now, personId, alertId).changes > 0
  );
}

// ---- reports ----

export interface ReportRow {
  report_id: string;
  report_type: "monthly" | "quarterly" | "annual" | "adhoc";
  period_start: string;
  period_end: string;
  content_md: string;
  data_json: string | null;
  created_at: string;
}

export function saveReport(row: Omit<ReportRow, "report_id">): ReportRow {
  const full: ReportRow = { report_id: randomUUID(), ...row };
  getDb()
    .prepare(
      `INSERT INTO reports (report_id, report_type, period_start, period_end, content_md, data_json, created_at)
       VALUES (@report_id, @report_type, @period_start, @period_end, @content_md, @data_json, @created_at)`,
    )
    .run(full);
  return full;
}

export function listReports(type?: ReportRow["report_type"]): Omit<ReportRow, "content_md" | "data_json">[] {
  const where = type ? "WHERE report_type = @type" : "";
  return getDb()
    .prepare(
      `SELECT report_id, report_type, period_start, period_end, created_at FROM reports ${where} ORDER BY period_start DESC`,
    )
    .all({ type }) as Omit<ReportRow, "content_md" | "data_json">[];
}

export function getReport(reportId: string): ReportRow | undefined {
  return getDb().prepare(`SELECT * FROM reports WHERE report_id = ?`).get(reportId) as ReportRow | undefined;
}

export function reportForPeriod(type: ReportRow["report_type"], periodStart: string): ReportRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM reports WHERE report_type = ? AND period_start = ? ORDER BY created_at DESC LIMIT 1`)
    .get(type, periodStart) as ReportRow | undefined;
}

// ---- decisions ----

export interface DecisionRow {
  decision_id: string;
  date: string;
  title: string;
  body: string | null;
  links_json: string | null;
}

export function addDecision(input: Omit<DecisionRow, "decision_id">): DecisionRow {
  const row: DecisionRow = { decision_id: randomUUID(), ...input };
  getDb()
    .prepare(
      `INSERT INTO decisions (decision_id, date, title, body, links_json) VALUES (@decision_id, @date, @title, @body, @links_json)`,
    )
    .run(row);
  return row;
}

export function listDecisions(): DecisionRow[] {
  return getDb().prepare(`SELECT * FROM decisions ORDER BY date DESC`).all() as DecisionRow[];
}

// ---- sync runs ----

export interface SyncRunRow {
  run_id: string;
  started_at: string;
  finished_at: string | null;
  status: "running" | "success" | "partial" | "failed";
  stats_json: string | null;
}

export function startRun(now: string): string {
  const runId = randomUUID();
  getDb()
    .prepare(`INSERT INTO sync_runs (run_id, started_at, status) VALUES (?, ?, 'running')`)
    .run(runId, now);
  return runId;
}

export function finishRun(
  runId: string,
  status: "success" | "partial" | "failed",
  stats: unknown,
  now: string,
): void {
  getDb()
    .prepare(`UPDATE sync_runs SET finished_at = ?, status = ?, stats_json = ? WHERE run_id = ?`)
    .run(now, status, JSON.stringify(stats), runId);
}

export function lastSuccessfulRun(): SyncRunRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM sync_runs WHERE status IN ('success','partial') ORDER BY started_at DESC LIMIT 1`)
    .get() as SyncRunRow | undefined;
}
