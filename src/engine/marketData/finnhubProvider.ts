/**
 * engine/marketData/finnhubProvider.ts — optional fallback to Finnhub's free
 * tier (60 req/min). Enabled only when FINNHUB_API_KEY is set; otherwise it
 * reports `enabled = false` and the composite provider skips it. Finnhub is
 * US-centric and doesn't serve currency on its quote, so it's a resilience
 * layer behind Yahoo, not a replacement.
 */
import { config } from "../../config.js";
import type { AssetKind, DailyClose, MarketDataProvider, Quote, SymbolHit } from "./types.js";
import { mapWithConcurrency } from "./types.js";

const BASE = "https://finnhub.io/api/v1";
const KEY = config.marketData.finnhubApiKey;

async function getJson<T>(path: string): Promise<T> {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${BASE}${path}${sep}token=${encodeURIComponent(KEY)}`);
  if (!res.ok) throw new Error(`finnhub ${res.status} for ${path}`);
  return (await res.json()) as T;
}

function kindOf(type: string | undefined): AssetKind {
  switch ((type ?? "").toLowerCase()) {
    case "common stock": return "stock";
    case "etp":
    case "etf": return "etf";
    case "crypto": return "crypto";
    default: return "other";
  }
}

interface FinnhubSearch { result?: { symbol?: string; description?: string; type?: string; displaySymbol?: string }[] }

async function search(query: string): Promise<SymbolHit[]> {
  const body = await getJson<FinnhubSearch>(`/search?q=${encodeURIComponent(query)}`);
  return (body.result ?? [])
    .filter((r) => r.symbol)
    .slice(0, 10)
    .map((r) => ({
      symbol: r.symbol!,
      name: r.description ?? r.symbol!,
      kind: kindOf(r.type),
      exchange: null,
      currency: null,
      typeLabel: r.type ?? null,
    }));
}

interface FinnhubQuote { c?: number; pc?: number; dp?: number; t?: number }

async function quoteOne(symbol: string): Promise<Quote | null> {
  try {
    const q = await getJson<FinnhubQuote>(`/quote?symbol=${encodeURIComponent(symbol)}`);
    if (q.c == null || !Number.isFinite(q.c) || q.c === 0) return null;
    return {
      symbol,
      price: Math.round(q.c * 10000) / 10000,
      prevClose: q.pc ?? null,
      changePct: q.dp != null ? Math.round(q.dp * 100) / 100 : null,
      currency: "USD", // Finnhub quotes don't carry currency; US-centric
      marketState: null,
      asOf: q.t ? new Date(q.t * 1000).toISOString() : new Date().toISOString(),
      source: "finnhub",
    };
  } catch {
    return null;
  }
}

async function quote(symbols: string[]): Promise<Quote[]> {
  const results = await mapWithConcurrency(symbols, 4, quoteOne);
  return results.filter((q): q is Quote => q !== null);
}

async function dailyCloses(): Promise<DailyClose[]> {
  // Finnhub's candle endpoint is premium-gated; daily history stays on Yahoo.
  throw new Error("finnhub dailyCloses not supported");
}

export const finnhubProvider: MarketDataProvider = {
  name: "finnhub",
  enabled: KEY.length > 0,
  search,
  quote,
  dailyCloses,
};
