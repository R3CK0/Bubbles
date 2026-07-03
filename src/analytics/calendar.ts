/**
 * analytics/calendar.ts — date arithmetic for money schedules. Pure.
 * All dates are ISO strings; arithmetic goes through UTC to dodge DST.
 */
import type { DateISO, DateRange, Frequency, MonthISO } from "./types.js";

function toUtc(date: DateISO): Date {
  return new Date(`${date}T00:00:00Z`);
}

function fromUtc(d: Date): DateISO {
  return d.toISOString().slice(0, 10);
}

export function monthOf(date: DateISO): MonthISO {
  return date.slice(0, 7);
}

export function daysInMonth(month: MonthISO): number {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) throw new Error(`bad month: ${month}`);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Inclusive first..last day of the month. */
export function monthWindow(month: MonthISO): DateRange {
  return { start: `${month}-01`, end: `${month}-${String(daysInMonth(month)).padStart(2, "0")}` };
}

export function addMonths(month: MonthISO, n: number): MonthISO {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) throw new Error(`bad month: ${month}`);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

/** Inclusive list of months from a to b (a <= b). */
export function monthsBetween(a: MonthISO, b: MonthISO): MonthISO[] {
  const out: MonthISO[] = [];
  let cur = a;
  while (cur <= b) {
    out.push(cur);
    cur = addMonths(cur, 1);
  }
  return out;
}

export function addDays(date: DateISO, n: number): DateISO {
  const d = toUtc(date);
  d.setUTCDate(d.getUTCDate() + n);
  return fromUtc(d);
}

export function dayDiff(a: DateISO, b: DateISO): number {
  return Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / 86_400_000);
}

/** Same day-of-month n months later, clamped to month end (Jan 31 → Feb 28). */
export function addMonthsToDate(date: DateISO, n: number): DateISO {
  const day = Number(date.slice(8, 10));
  const targetMonth = addMonths(monthOf(date), n);
  const clamped = Math.min(day, daysInMonth(targetMonth));
  return `${targetMonth}-${String(clamped).padStart(2, "0")}`;
}

const MONTH_STEPS: Partial<Record<Frequency, number>> = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
};

const DAY_STEPS: Partial<Record<Frequency, number>> = {
  weekly: 7,
  biweekly: 14,
};

/**
 * All occurrence dates of a recurrence inside `range` (inclusive), given its
 * anchor (first known due date). Month-based frequencies keep the anchor's
 * day-of-month, clamped to short months. `endDate` truncates open-ended
 * schedules (a loan that ends). The single recurrence expander used by bills
 * projection, plan schedules, and due-date advancement.
 */
export function expandRecurrence(
  frequency: Frequency,
  anchorDate: DateISO,
  range: DateRange,
  endDate?: DateISO | null,
  intervalDays?: number | null,
): DateISO[] {
  const hardEnd = endDate && endDate < range.end ? endDate : range.end;
  if (anchorDate > hardEnd) return [];

  const out: DateISO[] = [];
  const monthStep = MONTH_STEPS[frequency];
  if (monthStep !== undefined) {
    // Jump close to the range start instead of walking from a distant anchor.
    let i = 0;
    if (anchorDate < range.start) {
      const gapMonths = monthsBetween(monthOf(anchorDate), monthOf(range.start)).length - 1;
      i = Math.max(0, Math.floor((gapMonths - 1) / monthStep));
    }
    for (; ; i++) {
      const d = addMonthsToDate(anchorDate, i * monthStep);
      if (d > hardEnd) break;
      if (d >= range.start) out.push(d);
    }
    return out;
  }

  const dayStep = frequency === "custom" ? intervalDays : DAY_STEPS[frequency];
  if (!dayStep || dayStep <= 0) {
    throw new Error(`recurrence '${frequency}' needs a positive interval`);
  }
  let start = anchorDate;
  if (start < range.start) {
    const gap = dayDiff(start, range.start);
    start = addDays(start, Math.ceil(gap / dayStep) * dayStep);
  }
  for (let d = start; d <= hardEnd; d = addDays(d, dayStep)) {
    if (d >= range.start) out.push(d);
  }
  return out;
}

/** Next occurrence strictly after `after`. */
export function nextOccurrence(
  frequency: Frequency,
  anchorDate: DateISO,
  after: DateISO,
  endDate?: DateISO | null,
  intervalDays?: number | null,
): DateISO | null {
  const horizon = addDays(after, 400);
  const hits = expandRecurrence(
    frequency,
    anchorDate,
    { start: addDays(after, 1), end: horizon },
    endDate,
    intervalDays,
  );
  return hits[0] ?? null;
}
