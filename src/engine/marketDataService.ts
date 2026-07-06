/**
 * engine/marketDataService.ts — market prices for user-entered symbols.
 * Daily closes and intraday quotes both come through the vendor-agnostic
 * provider seam (engine/marketData: Yahoo primary, Finnhub fallback). This
 * module owns the DB side: filling security_prices for history and
 * security_quotes for the live 5-min cache. Error-tolerant — a failed symbol
 * degrades to carry-forward pricing, never throws into the pipeline.
 */
import {
  latestPriceDate,
  positionSymbols,
  securityExists,
  upsertPrices,
  upsertQuotes,
  upsertSecurities,
  type QuoteRow,
} from "../db/repositories/investments.js";
import { dailyCloses, quoteSymbols, searchSymbols } from "./marketData/index.js";
import type { DailyClose } from "./marketData/index.js";

export type { DailyClose };

/** Fetch daily closes for one symbol over `rangeDays` (max ~10y). */
export function fetchDailyCloses(symbol: string, rangeDays: number): Promise<DailyClose[]> {
  return dailyCloses(symbol, rangeDays);
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

export interface QuoteRefreshResult {
  requested: number;
  quoted: number;
  asOf: string | null;
}

/**
 * Live intraday refresh for the given symbols (defaults to all held symbols):
 * fetch current quotes, cache them in security_quotes, and stamp today's
 * security_prices so holdings/allocation/series reflect the live price when the
 * caller rebuilds today's snapshot. The authoritative daily close is finalized
 * later by the nightly refreshPrices — this is a same-day overwrite.
 */
export async function refreshQuotes(today: string, symbols?: string[]): Promise<QuoteRefreshResult> {
  const list = symbols ?? positionSymbols();
  if (list.length === 0) return { requested: 0, quoted: 0, asOf: null };
  const quotes = await quoteSymbols(list);
  if (quotes.length === 0) return { requested: list.length, quoted: 0, asOf: null };

  const now = new Date().toISOString();
  const quoteRows: QuoteRow[] = quotes.map((q) => ({
    security_id: q.symbol,
    price: q.price,
    prev_close: q.prevClose,
    change_pct: q.changePct,
    currency: q.currency,
    market_state: q.marketState,
    source: q.source,
    as_of: q.asOf || now,
    raw_json: null,
  }));
  upsertQuotes(quoteRows);

  // Fold the live price into today's daily row so downstream value math is live.
  for (const q of quotes) {
    if (!securityExists(q.symbol)) {
      upsertSecurities([
        { security_id: q.symbol, ticker: q.symbol, name: q.symbol, sec_type: null, currency: q.currency, isin: null, raw_json: null },
      ]);
    }
  }
  upsertPrices(quotes.map((q) => ({ security_id: q.symbol, date: today, close_price: q.price, currency: q.currency })));

  const asOf = quoteRows.reduce<string | null>((max, r) => (max === null || r.as_of > max ? r.as_of : max), null);
  return { requested: list.length, quoted: quotes.length, asOf };
}

/** Cheap symbol validation for the entry form: one quote fetch. */
export async function validateSymbol(symbol: string): Promise<{ valid: boolean; currency?: string; lastClose?: number; name?: string }> {
  try {
    const [quote] = await quoteSymbols([symbol]);
    if (quote) return { valid: true, currency: quote.currency, lastClose: quote.price };
    const closes = await fetchDailyCloses(symbol, 7);
    const last = closes[closes.length - 1];
    return last ? { valid: true, currency: last.currency, lastClose: last.close } : { valid: false };
  } catch {
    return { valid: false };
  }
}

export { searchSymbols };
