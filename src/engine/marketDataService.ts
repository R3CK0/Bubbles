/**
 * engine/marketDataService.ts — daily close prices for user-entered symbols,
 * via Yahoo Finance's public chart endpoint (no key; TSX symbols use the .TO
 * suffix, crypto pairs like BTC-CAD work directly). Error-tolerant: a failed
 * symbol degrades to carry-forward pricing, never throws into the pipeline.
 * The second non-Plaid external call (after the Bank of Canada) — both fetch
 * public market data only, nothing about the household leaves the machine.
 */
import { addDays } from "../analytics/calendar.js";
import {
  latestPriceDate,
  positionSymbols,
  securityExists,
  upsertPrices,
  upsertSecurities,
} from "../db/repositories/investments.js";

const CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";
const UA = { "User-Agent": "Mozilla/5.0 (local-first household finance; single user)" };

interface ChartResponse {
  chart?: {
    result?: {
      meta?: { currency?: string; shortName?: string; instrumentType?: string };
      timestamp?: number[];
      indicators?: { quote?: { close?: (number | null)[] }[] };
    }[];
    error?: { description?: string } | null;
  };
}

export interface DailyClose {
  date: string;
  close: number;
  currency: string;
}

/** Fetch daily closes for one symbol over `rangeDays` (max Yahoo '10y'). */
export async function fetchDailyCloses(symbol: string, rangeDays: number): Promise<DailyClose[]> {
  const range = rangeDays <= 7 ? "7d" : rangeDays <= 30 ? "1mo" : rangeDays <= 92 ? "3mo" : rangeDays <= 366 ? "1y" : rangeDays <= 1830 ? "5y" : "10y";
  const res = await fetch(`${CHART_URL}/${encodeURIComponent(symbol)}?range=${range}&interval=1d`, { headers: UA });
  if (!res.ok) throw new Error(`yahoo ${res.status} for ${symbol}`);
  const body = (await res.json()) as ChartResponse;
  const result = body.chart?.result?.[0];
  if (!result?.timestamp || !result.indicators?.quote?.[0]?.close) {
    throw new Error(body.chart?.error?.description ?? `no chart data for ${symbol}`);
  }
  const currency = result.meta?.currency ?? "CAD";
  const closes = result.indicators.quote[0].close;
  const out: DailyClose[] = [];
  for (let i = 0; i < result.timestamp.length; i++) {
    const close = closes[i];
    if (close === null || close === undefined || !Number.isFinite(close)) continue;
    out.push({
      date: new Date(result.timestamp[i]! * 1000).toISOString().slice(0, 10),
      close: Math.round(close * 10000) / 10000,
      currency,
    });
  }
  return out;
}

export interface PriceRefreshResult {
  symbols: number;
  pricesFetched: number;
  errors: { symbol: string; error: string }[];
}

/** Test seam: replace the fetcher (unit tests stub the network). */
export let _fetchCloses = fetchDailyCloses;
export function _setFetchClosesForTests(fn: typeof fetchDailyCloses | null): void {
  _fetchCloses = fn ?? fetchDailyCloses;
}

/**
 * Bring stored prices up to `today` for every symbol in use. Fetches only the
 * missing tail per symbol (or ~1y of history for brand-new symbols so charts
 * have context immediately).
 */
export async function refreshPrices(today: string): Promise<PriceRefreshResult> {
  const symbols = positionSymbols();
  const errors: { symbol: string; error: string }[] = [];
  let pricesFetched = 0;

  for (const symbol of symbols) {
    const last = latestPriceDate(symbol);
    if (last && last >= today) continue;
    const gapDays = last ? Math.max(2, Math.ceil((Date.parse(today) - Date.parse(last)) / 86_400_000) + 2) : 366;
    try {
      const closes = await _fetchCloses(symbol, gapDays);
      const fresh = closes.filter((c) => !last || c.date > last);
      if (fresh.length > 0) {
        const currency = fresh[fresh.length - 1]!.currency;
        // Don't clobber the sec_type the position entry classified.
        if (!securityExists(symbol)) {
          upsertSecurities([
            { security_id: symbol, ticker: symbol, name: symbol, sec_type: null, currency, isin: null, raw_json: null },
          ]);
        }
        upsertPrices(fresh.map((c) => ({ security_id: symbol, date: c.date, close_price: c.close, currency: c.currency })));
        pricesFetched += fresh.length;
      }
    } catch (err) {
      errors.push({ symbol, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { symbols: symbols.length, pricesFetched, errors };
}

/** Cheap symbol validation for the entry form: one quote fetch. */
export async function validateSymbol(symbol: string): Promise<{ valid: boolean; currency?: string; lastClose?: number }> {
  try {
    const closes = await _fetchCloses(symbol, 7);
    const last = closes[closes.length - 1];
    return last ? { valid: true, currency: last.currency, lastClose: last.close } : { valid: false };
  } catch {
    return { valid: false };
  }
}
