/**
 * engine/marketData/types.ts — the vendor-agnostic market-data contract.
 *
 * One MarketDataProvider covers every asset class the portfolio can hold:
 * equities, ETFs, FX pairs, futures/commodities, options and crypto. Yahoo is
 * the keyless primary; Finnhub is an optional fallback. The composite provider
 * (index.ts) is the only thing the rest of the app imports, so routes/jobs
 * never see a vendor.
 */

/** Broad asset classes, aligned with manual_positions.asset_type. */
export type AssetKind = "stock" | "etf" | "crypto" | "option" | "currency" | "commodity" | "index" | "other";

/** A symbol-search hit for the add-ticker autocomplete. */
export interface SymbolHit {
  symbol: string;
  name: string;
  kind: AssetKind;
  exchange: string | null;
  currency: string | null;
  /** Vendor-native type label, for display ("Equity", "Currency", …). */
  typeLabel: string | null;
}

/** A live/intraday quote. `asOf` is an ISO timestamp of the vendor's last tick. */
export interface Quote {
  symbol: string;
  price: number;
  prevClose: number | null;
  changePct: number | null;
  currency: string;
  marketState: string | null;
  asOf: string;
  source: string;
}

/** A daily close (kept structurally identical to marketDataService.DailyClose). */
export interface DailyClose {
  date: string;
  close: number;
  currency: string;
}

/** One row of an option chain (a single call or put at one strike). */
export interface OptionQuote {
  contractSymbol: string;
  strike: number;
  optionType: "call" | "put";
  expiry: string;
  bid: number | null;
  ask: number | null;
  lastPrice: number | null;
  impliedVol: number | null;
  currency: string;
}

/** The chain for one underlying at one expiry, plus every available expiry. */
export interface OptionChain {
  underlying: string;
  expiry: string;
  expiries: string[];
  currency: string;
  calls: OptionQuote[];
  puts: OptionQuote[];
}

export interface MarketDataProvider {
  readonly name: string;
  /** True when this provider is usable (e.g. Finnhub needs a key). */
  readonly enabled: boolean;
  search(query: string): Promise<SymbolHit[]>;
  quote(symbols: string[]): Promise<Quote[]>;
  dailyCloses(symbol: string, rangeDays: number): Promise<DailyClose[]>;
  /** Optional: not every provider serves option chains. */
  optionChain?(underlying: string, expiry?: string): Promise<OptionChain>;
}

/** Run async work over `items` with a small concurrency cap (polite fan-out). */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}
