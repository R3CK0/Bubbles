/**
 * engine/marketData/index.ts — the single market-data surface the app imports.
 * Yahoo is primary; Finnhub (when a key is configured) backs it up: on a Yahoo
 * failure or empty result we retry with Finnhub, and search results from both
 * are merged/deduped. Option chains and daily closes are Yahoo-only.
 */
import { yahooProvider } from "./yahooProvider.js";
import { finnhubProvider } from "./finnhubProvider.js";
import type { DailyClose, OptionChain, Quote, SymbolHit } from "./types.js";

export type { AssetKind, DailyClose, OptionChain, OptionQuote, Quote, SymbolHit } from "./types.js";

const fallback = finnhubProvider.enabled ? finnhubProvider : null;

/** Merge search hits, primary first, deduped by symbol. */
export async function searchSymbols(query: string): Promise<SymbolHit[]> {
  const q = query.trim();
  if (q.length < 1) return [];
  let primary: SymbolHit[] = [];
  try {
    primary = await yahooProvider.search(q);
  } catch {
    primary = [];
  }
  if (!fallback) return primary;
  let extra: SymbolHit[] = [];
  try {
    extra = await fallback.search(q);
  } catch {
    extra = [];
  }
  const seen = new Set(primary.map((h) => h.symbol.toUpperCase()));
  return [...primary, ...extra.filter((h) => !seen.has(h.symbol.toUpperCase()))].slice(0, 12);
}

/** Live quotes for a batch of symbols; Finnhub fills any Yahoo misses. */
export async function quoteSymbols(symbols: string[]): Promise<Quote[]> {
  const unique = [...new Set(symbols)].filter(Boolean);
  if (unique.length === 0) return [];
  let quotes: Quote[] = [];
  try {
    quotes = await yahooProvider.quote(unique);
  } catch {
    quotes = [];
  }
  if (fallback) {
    const have = new Set(quotes.map((q) => q.symbol));
    const missing = unique.filter((s) => !have.has(s));
    if (missing.length > 0) {
      try {
        quotes = quotes.concat(await fallback.quote(missing));
      } catch {
        /* keep what Yahoo gave us */
      }
    }
  }
  return quotes;
}

/** Daily closes (Yahoo only — the authoritative history source). */
export function dailyCloses(symbol: string, rangeDays: number): Promise<DailyClose[]> {
  return yahooProvider.dailyCloses(symbol, rangeDays);
}

/** Option chain for an underlying at an optional expiry (Yahoo only). */
export function optionChain(underlying: string, expiry?: string): Promise<OptionChain> {
  if (!yahooProvider.optionChain) throw new Error("option chains unavailable");
  return yahooProvider.optionChain(underlying, expiry);
}
