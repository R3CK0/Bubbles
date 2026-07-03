/**
 * engine/recurringService.ts — Bills & Recurring page + detection pipeline.
 */
import { randomUUID } from "node:crypto";
import {
  detectRecurring,
  expandRecurrence,
  lowBalanceWindows,
  matchTransaction,
  nextOccurrence,
  priceCreep,
  projectBalances,
  addDays,
  roundCents,
  type LowWindow,
  type ScheduledEvent,
  type TimePoint,
} from "../analytics/index.js";
import type { EngineContext } from "./context.js";
import { getDb } from "../db/db.js";
import {
  advanceNextDue,
  amountHistory,
  deleteRecurring,
  getRecurring,
  linkTransaction,
  listRecurring,
  propagateReimbursement,
  proposeDetected,
  setRecurringStatus,
  toRecurringEntry,
  unlinkedChargeIds,
  upsertRecurring,
  type RecurringPaymentRow,
} from "../db/repositories/recurring.js";
import {
  activeBudgetForMonth,
  flowsForRange,
  listCategories,
  listRules,
  retargetRule,
} from "../db/repositories/budgeting.js";
import { createAlert, getNumberSetting } from "../db/repositories/ops.js";
import { normalizeMerchant } from "../analytics/recurring.js";
import { addMonths, monthOf } from "../analytics/index.js";
import { categorizeRange, saveRule } from "./categorizationService.js";

/** Weekly-ish detection sweep over 12 months of history → proposed tray. */
export function runDetection(today: string): { candidates: number; proposed: number } {
  const start = addDays(today, -365);
  const flows = flowsForRange({ start, end: today }).filter((t) => t.reimbursedBy === null || true);
  const candidates = detectRecurring(flows).filter((c) => c.confidence >= 0.5);
  const proposed = proposeDetected(candidates, new Date().toISOString());
  return { candidates: candidates.length, proposed };
}

/** Nightly: link fresh charges to registry entries, advance due dates, flag creep. */
export function matchNewTransactions(range: { start: string; end: string }, now: string): {
  matched: number;
  creepAlerts: number;
} {
  const registry = listRecurring("active");
  const reimbursedByRp = new Map(registry.map((r) => [r.rp_id, r.reimbursed_by]));
  const entries = registry.map(toRecurringEntry);
  const ids = new Set(unlinkedChargeIds(range));
  const flows = flowsForRange(range).filter((t) => ids.has(t.transactionId));

  let matched = 0;
  let creepAlerts = 0;
  for (const tx of flows) {
    const entry = matchTransaction(tx, entries);
    if (!entry) continue;
    linkTransaction(tx.transactionId, entry.rpId, reimbursedByRp.get(entry.rpId) ?? null);
    const next =
      nextOccurrence(entry.frequency, entry.anchorDate, tx.date, entry.endDate, entry.intervalDays) ??
      entry.nextDueDate;
    advanceNextDue(entry.rpId, next);
    entry.nextDueDate = next;
    matched++;

    const creep = priceCreep(tx.amount, entry);
    if (creep) {
      const created = createAlert(
        {
          alert_type: "price_creep",
          severity: "info",
          title: `${entry.name} charged $${tx.amount.toFixed(2)} — $${creep.delta.toFixed(2)} above expected`,
          body: `Expected $${entry.expectedAmount.toFixed(2)} (+${creep.pct.toFixed(1)}%). Update the expected amount if this is the new price.`,
          payload: { rpId: entry.rpId, amount: tx.amount, expected: entry.expectedAmount },
        },
        now,
      );
      if (created) creepAlerts++;
    }
  }
  return { matched, creepAlerts };
}

export interface BillsCalendar {
  month: string;
  days: { date: string; items: { rpId: string; name: string; amount: number; personId: string | null }[]; total: number }[];
  projection: TimePoint[];
  lowWindows: LowWindow[];
  bufferFloor: number;
  startBalance: number;
}

/**
 * Calendar of dues + projected household liquid balance. Income events are a
 * heuristic (budgeted income on the 1st) until payday detection lands.
 */
export function getBillsCalendar(ctx: EngineContext): BillsCalendar {
  const registry = listRecurring("active");
  const days = new Map<string, BillsCalendar["days"][number]>();
  const events: ScheduledEvent[] = [];

  for (const rp of registry) {
    const dues = expandRecurrence(rp.frequency, rp.anchor_date, ctx.range, rp.end_date, rp.interval_days);
    for (const date of dues) {
      const day = days.get(date) ?? { date, items: [], total: 0 };
      day.items.push({ rpId: rp.rp_id, name: rp.name, amount: rp.expected_amount, personId: rp.person_id });
      day.total = roundCents(day.total + rp.expected_amount);
      days.set(date, day);
      events.push({ date, amount: -rp.expected_amount, label: rp.name });
    }
  }

  // Heuristic income event: active budget's income lines land on the 1st.
  const budget = activeBudgetForMonth(ctx.month);
  if (budget) {
    const incomeIds = new Set(
      listCategories()
        .filter((c) => c.kind === "income")
        .map((c) => c.category_id),
    );
    const income = budget.lines
      .filter((l) => incomeIds.has(l.category_id))
      .reduce((s, l) => s + l.monthly_amount, 0);
    if (income > 0) events.push({ date: ctx.range.start, amount: roundCents(income), label: "Expected income" });
  }

  const startBalance = (
    getDb()
      .prepare(
        `SELECT COALESCE(SUM(current_balance), 0) AS s FROM accounts
         WHERE tracked = 1 AND is_closed = 0 AND type = 'depository'`,
      )
      .get() as { s: number }
  ).s;

  const bufferFloor = getNumberSetting("buffer_floor", 500);
  const projection = projectBalances(roundCents(startBalance), events, ctx.range);

  return {
    month: ctx.month,
    days: [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
    projection,
    lowWindows: lowBalanceWindows(projection, bufferFloor),
    bufferFloor,
    startBalance: roundCents(startBalance),
  };
}

export interface RegistryItem extends RecurringPaymentRow {
  priceHistory: { date: string; amount: number }[];
}

export function getRegistry(status?: RecurringPaymentRow["status"]): RegistryItem[] {
  return listRecurring(status).map((rp) => ({ ...rp, priceHistory: amountHistory(rp.rp_id) }));
}

export interface RecurringInput {
  rpId?: string;
  name: string;
  categoryId?: string | null;
  personId?: string | null;
  accountId?: string | null;
  expectedAmount: number;
  amountTolerance?: number;
  frequency: RecurringPaymentRow["frequency"];
  intervalDays?: number | null;
  anchorDate: string;
  endDate?: string | null;
  autopay?: boolean;
  reimbursedBy?: "work" | "buildings" | null;
  debtId?: string | null;
}

export function saveRecurring(input: RecurringInput, today: string): RecurringPaymentRow {
  const existing = input.rpId ? getRecurring(input.rpId) : undefined;
  const nextDue =
    nextOccurrence(input.frequency, input.anchorDate, addDays(today, -1), input.endDate, input.intervalDays) ??
    input.anchorDate;
  const row: RecurringPaymentRow = {
    rp_id: input.rpId ?? randomUUID(),
    name: input.name,
    category_id: input.categoryId ?? existing?.category_id ?? null,
    person_id: input.personId ?? existing?.person_id ?? null,
    account_id: input.accountId ?? existing?.account_id ?? null,
    expected_amount: input.expectedAmount,
    amount_tolerance: input.amountTolerance ?? existing?.amount_tolerance ?? 0.05,
    currency: existing?.currency ?? "CAD",
    frequency: input.frequency,
    interval_days: input.intervalDays ?? null,
    anchor_date: input.anchorDate,
    next_due_date: nextDue,
    end_date: input.endDate ?? null,
    autopay: (input.autopay ?? true) ? 1 : 0,
    reimbursed_by: input.reimbursedBy ?? existing?.reimbursed_by ?? null,
    debt_id: input.debtId ?? existing?.debt_id ?? null,
    source: existing?.source ?? "manual",
    status: existing?.status === "proposed" ? "proposed" : (existing?.status ?? "active"),
    created_at: existing?.created_at ?? new Date().toISOString(),
  };
  upsertRecurring(row);
  // marking a bill "work/buildings pays" also retro-flags its matched
  // transactions so past months' budgets stop counting them
  if (row.reimbursed_by) propagateReimbursement(row.rp_id, row.reimbursed_by);
  return row;
}

export interface BillCategoryResult {
  recurring: RecurringPaymentRow;
  ruleId: string;
  /** true = an existing merchant mapping (locked or not) was retargeted; false = a new locked mapping was created. */
  ruleUpdated: boolean;
  /** transactions re-categorized retroactively (manual categorizations are never touched). */
  applied: number;
}

/**
 * Bills → "edit category": the one deliberate path that moves a merchant
 * mapping, locked or not. Updates the bill row, retargets the rule whose
 * merchant pattern covers this bill (or creates a new locked one), then
 * re-applies rules retroactively so past charges follow the new category.
 */
export function setBillCategory(
  rpId: string,
  categoryId: string,
  retroactiveMonths = 12,
): BillCategoryResult | null {
  const rp = getRecurring(rpId);
  if (!rp) return null;
  if (!listCategories(true).some((c) => c.category_id === categoryId)) {
    throw Object.assign(new Error(`unknown category: ${categoryId}`), { status: 400 });
  }

  upsertRecurring({ ...rp, category_id: categoryId });

  // The mapping that covers this bill: merchant pattern and bill name contain
  // each other after normalization (mirrors how charges match the registry).
  const billName = normalizeMerchant(rp.name);
  const existing = listRules(false).find((r) => {
    if (!r.merchant_pattern || !billName) return false;
    const pattern = normalizeMerchant(r.merchant_pattern);
    return !!pattern && (pattern.includes(billName) || billName.includes(pattern));
  });

  let ruleId: string;
  let ruleUpdated = false;
  if (existing) {
    retargetRule(existing.rule_id, categoryId);
    ruleId = existing.rule_id;
    ruleUpdated = true;
  } else {
    ruleId = saveRule(
      { priority: 50, merchantPattern: rp.name, categoryId, source: "manual", lock: true },
      0,
    ).ruleId;
  }

  let applied = 0;
  if (retroactiveMonths > 0) {
    const today = new Date().toISOString().slice(0, 10);
    applied = categorizeRange({ start: `${addMonths(monthOf(today), -retroactiveMonths)}-01`, end: today });
  }
  return { recurring: getRecurring(rpId)!, ruleId, ruleUpdated, applied };
}

export function acceptProposed(rpId: string): boolean {
  const rp = getRecurring(rpId);
  if (!rp || rp.status !== "proposed") return false;
  setRecurringStatus(rpId, "active");
  return true;
}

export function dismissProposed(rpId: string): boolean {
  const rp = getRecurring(rpId);
  if (!rp || rp.status !== "proposed") return false;
  deleteRecurring(rpId);
  return true;
}

export function removeRecurring(rpId: string): boolean {
  const rp = getRecurring(rpId);
  if (!rp) return false;
  deleteRecurring(rpId);
  return true;
}

/** Annual/semiannual renewals due within `daysAhead`. */
export function getRenewalsAhead(today: string, daysAhead = 30): RecurringPaymentRow[] {
  const horizon = addDays(today, daysAhead);
  return listRecurring("active").filter(
    (rp) =>
      (rp.frequency === "annual" || rp.frequency === "semiannual") &&
      rp.next_due_date >= today &&
      rp.next_due_date <= horizon,
  );
}
