/**
 * engine/alertsService.ts — alert evaluation and lifecycle. Rules judge
 * *service* outputs (thresholds live here, in one place); dedup lives in the
 * ops repo. price_creep is emitted by recurringService at match time.
 */
import type { EngineContext } from "./context.js";
import { acknowledgeAlert, createAlert, openAlerts, lastSuccessfulRun, type AlertRow } from "../db/repositories/ops.js";
import { getBudgetView } from "./budgetService.js";
import { getBillsCalendar, getRenewalsAhead } from "./recurringService.js";
import { solve } from "./planningService.js";
import { getAllocation } from "./portfolioService.js";
import { getRoom } from "./taxService.js";

export interface AlertSweepStats {
  created: number;
  rulesRun: number;
}

export function evaluateAll(ctx: EngineContext): AlertSweepStats {
  const now = new Date().toISOString();
  let created = 0;
  const emit = (input: Parameters<typeof createAlert>[0]) => {
    if (createAlert(input, now)) created++;
  };

  // 1. overspend pace (only meaningful mid-month, with real spend behind it)
  const budget = getBudgetView(ctx);
  if (budget.dayFraction > 0.25 && budget.dayFraction < 1) {
    for (const row of budget.rows) {
      if (row.kind !== "expense" || row.budget < 50 || row.actual < 100) continue;
      if ((row.pace ?? 0) > 1.25) {
        emit({
          alert_type: "overspend_pace",
          severity: "warning",
          title: `${row.name}: ${Math.round((row.pace ?? 0) * 100)}% of pace, $${row.actual.toFixed(0)} of $${row.budget.toFixed(0)}`,
          body: `At this rate the ${row.name} budget runs out before month end.`,
          payload: { categoryId: row.categoryId, month: ctx.month },
        });
      }
    }
  }

  // 2. low balance ahead
  const bills = getBillsCalendar(ctx);
  for (const w of bills.lowWindows) {
    emit({
      alert_type: "low_balance",
      severity: "warning",
      title: `Projected balance dips to $${w.minBalance.toFixed(0)} around ${w.start}`,
      body: `Below the $${bills.bufferFloor.toFixed(0)} buffer between ${w.start} and ${w.end}.`,
      payload: { start: w.start, month: ctx.month },
    });
  }

  // 3. goal off-track
  const solved = solve(ctx);
  for (const g of solved.perGoal) {
    if (g.feasible === "no") {
      emit({
        alert_type: "goal_off_track",
        severity: "warning",
        title: `Goal '${g.name}' is off track — $${g.gap.toFixed(0)} short`,
        body: g.requiredMonthly ? `Needs $${g.requiredMonthly.toFixed(0)}/mo from here.` : null,
        payload: { goalId: g.goalId },
      });
    }
  }

  // 4. renewals ahead (annual/semiannual within 30 days)
  for (const rp of getRenewalsAhead(ctx.today, 30)) {
    emit({
      alert_type: "renewal_ahead",
      severity: "info",
      title: `${rp.name} renews ${rp.next_due_date} ($${rp.expected_amount.toFixed(2)})`,
      body: "Cancel or renegotiate before it charges.",
      payload: { rpId: rp.rp_id, due: rp.next_due_date },
    });
  }

  // 5. allocation drift
  for (const slice of getAllocation(ctx)) {
    if (slice.drift !== null && Math.abs(slice.drift) > 0.05) {
      emit({
        alert_type: "allocation_drift",
        severity: "info",
        title: `${slice.class} is ${slice.drift > 0 ? "+" : ""}${(slice.drift * 100).toFixed(1)}% vs target`,
        body: null,
        payload: { class: slice.class, month: ctx.month },
      });
    }
  }

  // 6. registered-room deadlines: FHSA is calendar-year (December nudge),
  //    RRSP first-60-days (January/February nudge).
  const monthNum = Number(ctx.month.slice(5, 7));
  const year = Number(ctx.month.slice(0, 4));
  try {
    const room = getRoom(ctx, year);
    if (monthNum === 12) {
      for (const r of room.filter((r) => r.accountType === "FHSA" && r.remaining > 0)) {
        emit({
          alert_type: "room_deadline",
          severity: "info",
          title: `${r.personId}: $${r.remaining.toFixed(0)} of FHSA room expires with the calendar year`,
          body: "FHSA room is use-it-by-December for this year's deduction.",
          payload: { personId: r.personId, type: "FHSA", year },
        });
      }
    }
    if (monthNum <= 2) {
      for (const r of room.filter((r) => r.accountType === "RRSP" && r.remaining > 0)) {
        emit({
          alert_type: "room_deadline",
          severity: "info",
          title: `${r.personId}: RRSP first-60-days window — $${r.remaining.toFixed(0)} room usable against ${year - 1}`,
          body: null,
          payload: { personId: r.personId, type: "RRSP", year },
        });
      }
    }
  } catch {
    // no tax tables yet — room nudges are best-effort
  }

  // 7. stale sync
  const last = lastSuccessfulRun();
  if (last && Date.now() - new Date(last.started_at).getTime() > 48 * 3600_000) {
    emit({
      alert_type: "stale_sync",
      severity: "critical",
      title: "Data is stale — last successful sync over 48h ago",
      body: "Check the vault session grant (npm run vault -- status).",
      payload: { lastRun: last.started_at },
    });
  }

  return { created, rulesRun: 7 };
}

export function getOpenAlerts(): AlertRow[] {
  return openAlerts();
}

export function ackAlert(alertId: string, personId: string | null): boolean {
  return acknowledgeAlert(alertId, personId, new Date().toISOString());
}
