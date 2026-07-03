/**
 * analytics/projection.ts — forward balance curves. Pure.
 * v1 projects the household's total liquid balance (per-account curves come
 * with account-routing of bills, a later refinement).
 */
import type { DateISO, DateRange, TimePoint } from "./types.js";
import { addDays } from "./calendar.js";
import { roundCents } from "./money.js";

/** A scheduled money event; amount uses engine convention (inflow > 0). */
export interface ScheduledEvent {
  date: DateISO;
  amount: number;
  label: string;
}

/**
 * Daily projected total balance across `range`, starting from `startBalance`
 * at range.start (events on range.start apply that same day).
 */
export function projectBalances(
  startBalance: number,
  events: ScheduledEvent[],
  range: DateRange,
): TimePoint[] {
  const byDate = new Map<string, number>();
  for (const e of events) {
    if (e.date < range.start || e.date > range.end) continue;
    byDate.set(e.date, (byDate.get(e.date) ?? 0) + e.amount);
  }
  const points: TimePoint[] = [];
  let balance = startBalance;
  for (let d = range.start; d <= range.end; d = addDays(d, 1)) {
    balance = roundCents(balance + (byDate.get(d) ?? 0));
    points.push({ date: d, value: balance });
  }
  return points;
}

export interface LowWindow {
  start: DateISO;
  end: DateISO;
  minBalance: number;
}

/** Contiguous ranges where the projection dips under the buffer floor. */
export function lowBalanceWindows(projection: TimePoint[], bufferFloor: number): LowWindow[] {
  const windows: LowWindow[] = [];
  let open: LowWindow | null = null;
  for (const p of projection) {
    if (p.value < bufferFloor) {
      if (!open) open = { start: p.date, end: p.date, minBalance: p.value };
      else {
        open.end = p.date;
        open.minBalance = Math.min(open.minBalance, p.value);
      }
    } else if (open) {
      windows.push(open);
      open = null;
    }
  }
  if (open) windows.push(open);
  return windows;
}
