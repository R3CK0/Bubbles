/**
 * jobs/nightly.ts — the nightly pipeline. Independent step failures don't
 * abort later steps; every run is bracketed by a sync_runs row.
 *
 * Steps (grows in step 4 with contributions + alerts):
 *   1. plaid sync        (skipped when the vault isn't unlocked)
 *   2. investments       (market prices for user-entered positions + snapshot
 *                         rebuild — Plaid investments needs prod access, so
 *                         portfolio state is user-maintained)
 *   3. fx rates          (skipped when no USD accounts)
 *   4. snapshots         (account balances + debt balance refresh)
 *   5. categorize        (rules over the last 60 days + transfer sweep)
 *   6. recurring         (match new charges; detection sweep on Sundays)
 *   7. goals             (funded-amount refresh from linked accounts)
 *   8. contributions     (registered-account deposits → contribution rows)
 *   9. alerts            (the full rule sweep)
 *  10. report            (1st of the month: build last month's report)
 */
import { addDays } from "../analytics/calendar.js";
import type { Vault } from "../vault/vault.js";
import { syncAllItems } from "../plaid/sync.js";
import { refreshAndRebuild } from "../engine/positionsService.js";
import { ensureRates } from "../engine/fxService.js";
import { snapshotAccounts } from "../engine/snapshotService.js";
import { categorizeRange, detectTransfers, matchPendingTransfers } from "../engine/categorizationService.js";
import { matchNewTransactions, runDetection } from "../engine/recurringService.js";
import { refreshGoalFunding } from "../engine/planningService.js";
import { detectContributions } from "../engine/taxService.js";
import { evaluateAll } from "../engine/alertsService.js";
import { runMonthlyReport } from "./monthlyReport.js";
import { monthOf, monthWindow } from "../analytics/calendar.js";
import { listPersons } from "../db/repository.js";
import type { EngineContext } from "../engine/context.js";
import { finishRun, startRun } from "../db/repositories/ops.js";

export interface NightlyStats {
  [step: string]: unknown;
}

export async function runNightly(vault: Vault | null): Promise<{ status: string; stats: NightlyStats }> {
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const runId = startRun(now);
  const stats: NightlyStats = {};
  const errors: string[] = [];

  const step = async (name: string, fn: () => Promise<unknown> | unknown) => {
    try {
      stats[name] = await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stats[name] = { error: message };
      errors.push(`${name}: ${message}`);
    }
  };

  await step("sync", async () => {
    if (!vault) return { skipped: "vault locked" };
    return syncAllItems(vault);
  });
  await step("investments", () => refreshAndRebuild(today));
  await step("fx", () => ensureRates(today));
  await step("snapshots", () => snapshotAccounts(today));
  await step("categorize", () => {
    const range = { start: addDays(today, -60), end: today };
    return {
      applied: categorizeRange(range),
      transferPairs: detectTransfers(range),
      // user-marked legs waiting for their counterpart (validates or alerts)
      pendingTransfers: matchPendingTransfers(today),
    };
  });
  await step("recurring", () => {
    const match = matchNewTransactions({ start: addDays(today, -30), end: today }, now);
    const isSunday = new Date(`${today}T00:00:00Z`).getUTCDay() === 0;
    return { ...match, detection: isSunday ? runDetection(today) : { skipped: "not sunday" } };
  });
  await step("goals", () => ({ fundedRefreshed: refreshGoalFunding() }));
  await step("contributions", () => ({
    recorded: detectContributions({ start: addDays(today, -60), end: today }),
  }));
  await step("alerts", () => {
    const persons = listPersons();
    const ctx: EngineContext = {
      lens: "combined",
      month: monthOf(today),
      range: monthWindow(monthOf(today)),
      persons,
      personNames: new Map(persons.map((p) => [p.person_id, p.display_name])),
      today,
    };
    return evaluateAll(ctx);
  });
  await step("report", () => {
    if (!today.endsWith("-01")) return { skipped: "not the 1st" };
    return runMonthlyReport(today);
  });

  const status = errors.length === 0 ? "success" : errors.length < 4 ? "partial" : "failed";
  finishRun(runId, status as "success" | "partial" | "failed", stats, new Date().toISOString());
  return { status, stats };
}
