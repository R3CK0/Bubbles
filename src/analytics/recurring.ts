/**
 * analytics/recurring.ts — detection and matching of recurring charges. Pure.
 */
import type { DateISO, FlowTx, Frequency } from "./types.js";
import { dayDiff } from "./calendar.js";
import { roundCents } from "./money.js";

export interface RecurringEntry {
  rpId: string;
  name: string;
  expectedAmount: number;
  amountTolerance: number;
  frequency: Frequency;
  intervalDays: number | null;
  anchorDate: DateISO;
  nextDueDate: DateISO;
  endDate: DateISO | null;
}

export interface DetectedCandidate {
  name: string;
  normalizedName: string;
  expectedAmount: number;
  frequency: Frequency;
  anchorDate: DateISO;
  occurrences: number;
  confidence: number;
}

/** Strip store numbers/dates so "NETFLIX #1234" groups with "Netflix". */
export function normalizeMerchant(name: string): string {
  return name
    .toLowerCase()
    .replace(/[#*]?\d{2,}/g, "")
    .replace(/[^a-z& ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const GAP_TO_FREQUENCY: { frequency: Frequency; days: number; tolerance: number; minOccurrences: number }[] = [
  { frequency: "weekly", days: 7, tolerance: 2, minOccurrences: 4 },
  { frequency: "biweekly", days: 14, tolerance: 3, minOccurrences: 3 },
  { frequency: "monthly", days: 30, tolerance: 4, minOccurrences: 3 },
  { frequency: "quarterly", days: 91, tolerance: 10, minOccurrences: 3 },
  { frequency: "semiannual", days: 182, tolerance: 15, minOccurrences: 2 },
  { frequency: "annual", days: 365, tolerance: 20, minOccurrences: 2 },
];

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Mine transaction history for recurring charges. Groups outflows by
 * normalized merchant, infers cadence from the median inter-charge gap, and
 * requires reasonable gap and amount stability. Confidence rises with
 * occurrence count and consistency.
 */
export function detectRecurring(txs: FlowTx[]): DetectedCandidate[] {
  const groups = new Map<string, FlowTx[]>();
  for (const tx of txs) {
    if (tx.amount <= 0 || tx.isTransfer || tx.pending) continue; // outflows only
    const raw = tx.merchantName ?? tx.payee;
    if (!raw) continue;
    const key = normalizeMerchant(raw);
    if (!key) continue;
    const list = groups.get(key) ?? [];
    list.push(tx);
    groups.set(key, list);
  }

  const candidates: DetectedCandidate[] = [];
  for (const [normalizedName, group] of groups) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => (a.date < b.date ? -1 : 1));
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) gaps.push(dayDiff(sorted[i - 1]!.date, sorted[i]!.date));
    if (gaps.length === 0) continue;
    const medGap = median(gaps);

    const spec = GAP_TO_FREQUENCY.find(
      (s) => Math.abs(medGap - s.days) <= s.tolerance && sorted.length >= s.minOccurrences,
    );
    if (!spec) continue;
    // Gap consistency: most gaps near the median.
    const consistent = gaps.filter((g) => Math.abs(g - medGap) <= spec.tolerance).length / gaps.length;
    if (consistent < 0.6) continue;
    // Amount stability: within 30% of the median (utilities wobble).
    const amounts = sorted.map((t) => t.amount);
    const medAmount = median(amounts);
    const stable = amounts.filter((a) => Math.abs(a - medAmount) <= medAmount * 0.3).length / amounts.length;
    if (stable < 0.7) continue;

    const last = sorted[sorted.length - 1]!;
    candidates.push({
      name: last.merchantName ?? last.payee ?? normalizedName,
      normalizedName,
      expectedAmount: roundCents(medAmount),
      frequency: spec.frequency,
      anchorDate: last.date,
      occurrences: sorted.length,
      confidence: Math.min(1, roundCents(0.3 + 0.1 * sorted.length * consistent * stable)),
    });
  }
  return candidates.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Match a charge to a registry entry: merchant name containment (either way,
 * normalized), amount within tolerance (floor $2), and dated within ±7 days
 * of the entry's next due date. Best match = smallest amount deviation.
 */
export function matchTransaction(tx: FlowTx, registry: RecurringEntry[]): RecurringEntry | null {
  if (tx.amount <= 0 || tx.isTransfer) return null;
  const txName = normalizeMerchant(tx.merchantName ?? tx.payee ?? "");
  if (!txName) return null;

  let best: RecurringEntry | null = null;
  let bestDev = Number.POSITIVE_INFINITY;
  for (const entry of registry) {
    const entryName = normalizeMerchant(entry.name);
    if (!entryName || !(txName.includes(entryName) || entryName.includes(txName))) continue;
    const tolerance = Math.max(entry.expectedAmount * entry.amountTolerance, 2);
    const deviation = Math.abs(tx.amount - entry.expectedAmount);
    // Generous cap so price creep still matches (then gets flagged).
    if (deviation > Math.max(tolerance * 4, entry.expectedAmount * 0.25)) continue;
    if (Math.abs(dayDiff(entry.nextDueDate, tx.date)) > 7) continue;
    if (deviation < bestDev) {
      best = entry;
      bestDev = deviation;
    }
  }
  return best;
}

export interface PriceCreep {
  delta: number;
  pct: number;
}

/** Non-null when a matched charge exceeds the entry's tolerance band. */
export function priceCreep(amount: number, entry: RecurringEntry): PriceCreep | null {
  const threshold = Math.max(entry.expectedAmount * entry.amountTolerance, 0.5);
  const delta = roundCents(amount - entry.expectedAmount);
  if (delta <= threshold) return null;
  return { delta, pct: roundCents((delta / entry.expectedAmount) * 100) };
}
