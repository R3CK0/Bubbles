/**
 * engine/fxService.ts — daily CAD/USD rate ingestion via the Bank of Canada
 * Valet API (public, no key). The ONLY engine module that talks to a
 * non-Plaid external service; failures degrade to carry-forward, never throw.
 */
import { addDays } from "../analytics/calendar.js";
import {
  hasNonCadAccounts,
  latestFxDate,
  upsertFxRates,
} from "../db/repositories/history.js";
import { hasNonCadPositions } from "../db/repositories/investments.js";
import { quoteSymbols } from "./marketData/index.js";

const VALET_URL = "https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json";

/** USD or CAD held anywhere (accounts or positions) → we need USD/CAD rates. */
function needsUsdCad(): boolean {
  return hasNonCadAccounts() || hasNonCadPositions();
}

export interface FxResult {
  fetched: number;
  skipped: boolean;
  error?: string;
}

/**
 * Ensure USD/CAD rates exist up to `today`. Skips entirely when no tracked
 * account holds USD (no pointless network). Fetches only the missing tail.
 */
export async function ensureRates(today: string): Promise<FxResult> {
  if (!needsUsdCad()) return { fetched: 0, skipped: true };

  const last = latestFxDate("USD", "CAD");
  const start = last ? addDays(last, 1) : addDays(today, -365);
  if (start > today) return { fetched: 0, skipped: false };

  try {
    const res = await fetch(`${VALET_URL}?start_date=${start}&end_date=${today}`);
    if (!res.ok) return { fetched: 0, skipped: false, error: `valet ${res.status}` };
    const body = (await res.json()) as {
      observations?: { d: string; FXUSDCAD?: { v: string } }[];
    };
    const rows = (body.observations ?? [])
      .filter((o) => o.FXUSDCAD?.v)
      .map((o) => ({ date: o.d, baseCcy: "USD", quoteCcy: "CAD", rate: Number(o.FXUSDCAD!.v) }))
      .filter((r) => Number.isFinite(r.rate) && r.rate > 0);
    upsertFxRates(rows);
    return { fetched: rows.length, skipped: false };
  } catch (err) {
    return { fetched: 0, skipped: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Overwrite today's USD/CAD with a live market rate (Yahoo `USDCAD=X`) so
 * intraday CAD conversions use a current rate rather than yesterday's Bank of
 * Canada close. Best-effort: a no-op when no USD is held or the quote fails.
 * The nightly ensureRates still writes the authoritative BoC close.
 */
export async function refreshLiveUsdCad(today: string): Promise<boolean> {
  if (!needsUsdCad()) return false;
  try {
    const [q] = await quoteSymbols(["USDCAD=X"]); // price = CAD per 1 USD
    if (!q || !Number.isFinite(q.price) || q.price <= 0) return false;
    upsertFxRates([{ date: today, baseCcy: "USD", quoteCcy: "CAD", rate: q.price }]);
    return true;
  } catch {
    return false;
  }
}
