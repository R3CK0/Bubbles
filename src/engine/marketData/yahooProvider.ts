/**
 * engine/marketData/yahooProvider.ts — Yahoo Finance's public JSON endpoints,
 * no API key. Covers the whole instrument universe the household can hold:
 *   - search   → v1/finance/search   (equities, ETFs, FX `=X`, futures `=F`,
 *                                      options, indices, crypto `-CAD`)
 *   - quote    → v8/finance/chart     (meta.regularMarketPrice — avoids the
 *                                      crumb-gated v7 quote endpoint)
 *   - closes   → v8/finance/chart     (daily closes; the pre-existing path)
 *   - options  → v7/finance/options   (expiries + strikes with bid/ask/IV)
 *
 * Error-tolerant by contract: callers degrade (carry-forward pricing, Finnhub
 * fallback) rather than crash. Nothing about the household leaves the machine —
 * these are public market-data reads only.
 */
import type {
  AssetKind,
  DailyClose,
  MarketDataProvider,
  OptionChain,
  OptionQuote,
  Quote,
  SymbolHit,
} from "./types.js";
import { mapWithConcurrency } from "./types.js";

const BASE = "https://query1.finance.yahoo.com";
const UA = { "User-Agent": "Mozilla/5.0 (local-first household finance; single user)" };

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`yahoo ${res.status} for ${url}`);
  return (await res.json()) as T;
}

// Some Yahoo endpoints (options) are cookie+crumb gated. We fetch a cookie and
// a crumb once, cache them, and refresh on a 401. Search/quote/closes don't
// need this, so only optionChain pays the handshake.
let crumbAuth: { cookie: string; crumb: string } | null = null;

async function getCrumbAuth(force = false): Promise<{ cookie: string; crumb: string } | null> {
  if (crumbAuth && !force) return crumbAuth;
  try {
    const seed = await fetch("https://fc.yahoo.com", { headers: UA });
    const setCookie = (seed.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    const cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
    const res = await fetch(`${BASE}/v1/test/getcrumb`, { headers: { ...UA, ...(cookie ? { Cookie: cookie } : {}) } });
    const crumb = (await res.text()).trim();
    if (!crumb || crumb.includes("<") || crumb.length > 32) return null;
    crumbAuth = { cookie, crumb };
    return crumbAuth;
  } catch {
    return null;
  }
}

/** GET a crumb-gated endpoint, refreshing the crumb once on a 401. */
async function getAuthedJson<T>(path: string): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const auth = await getCrumbAuth(attempt > 0);
    const sep = path.includes("?") ? "&" : "?";
    const url = `${BASE}${path}${auth ? `${sep}crumb=${encodeURIComponent(auth.crumb)}` : ""}`;
    const res = await fetch(url, { headers: { ...UA, ...(auth?.cookie ? { Cookie: auth.cookie } : {}) } });
    if (res.status === 401) {
      crumbAuth = null;
      continue;
    }
    if (!res.ok) throw new Error(`yahoo ${res.status} for ${url}`);
    return (await res.json()) as T;
  }
  throw new Error(`yahoo 401 (crumb) for ${path}`);
}

/** Map Yahoo's quoteType to our AssetKind. */
function kindOf(quoteType: string | undefined): AssetKind {
  switch ((quoteType ?? "").toUpperCase()) {
    case "EQUITY": return "stock";
    case "ETF": return "etf";
    case "MUTUALFUND": return "etf";
    case "CURRENCY": return "currency";
    case "FUTURE": return "commodity";
    case "OPTION": return "option";
    case "CRYPTOCURRENCY": return "crypto";
    case "INDEX": return "index";
    default: return "other";
  }
}

// ---- search ----

interface SearchResponse {
  quotes?: {
    symbol?: string;
    shortname?: string;
    longname?: string;
    exchange?: string;
    exchDisp?: string;
    quoteType?: string;
    typeDisp?: string;
    isYahooFinance?: boolean;
  }[];
}

async function search(query: string): Promise<SymbolHit[]> {
  const url = `${BASE}/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=10&newsCount=0&enableFuzzyQuery=false`;
  const body = await getJson<SearchResponse>(url);
  return (body.quotes ?? [])
    .filter((q) => q.symbol && q.isYahooFinance !== false)
    .map((q) => ({
      symbol: q.symbol!,
      name: q.longname ?? q.shortname ?? q.symbol!,
      kind: kindOf(q.quoteType),
      exchange: q.exchDisp ?? q.exchange ?? null,
      currency: null, // search doesn't carry currency; the quote fills it in
      typeLabel: q.typeDisp ?? null,
    }));
}

// ---- quote (intraday) + daily closes, both off the chart endpoint ----

interface ChartResponse {
  chart?: {
    result?: {
      meta?: {
        currency?: string;
        symbol?: string;
        regularMarketPrice?: number;
        previousClose?: number;
        chartPreviousClose?: number;
        regularMarketTime?: number;
        marketState?: string;
      };
      timestamp?: number[];
      indicators?: { quote?: { close?: (number | null)[] }[] };
    }[];
    error?: { description?: string } | null;
  };
}

function isoFromUnix(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

async function quoteOne(symbol: string): Promise<Quote | null> {
  try {
    const body = await getJson<ChartResponse>(
      `${BASE}/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m`,
    );
    const meta = body.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice;
    if (meta == null || price == null || !Number.isFinite(price)) return null;
    const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? null;
    const changePct = prevClose && prevClose !== 0 ? ((price - prevClose) / prevClose) * 100 : null;
    return {
      symbol,
      price: Math.round(price * 10000) / 10000,
      prevClose,
      changePct: changePct === null ? null : Math.round(changePct * 100) / 100,
      currency: meta.currency ?? "CAD",
      marketState: meta.marketState ?? null,
      asOf: meta.regularMarketTime ? isoFromUnix(meta.regularMarketTime) : new Date().toISOString(),
      source: "yahoo",
    };
  } catch {
    return null; // one bad symbol never sinks the batch
  }
}

async function quote(symbols: string[]): Promise<Quote[]> {
  const results = await mapWithConcurrency(symbols, 4, quoteOne);
  return results.filter((q): q is Quote => q !== null);
}

async function dailyCloses(symbol: string, rangeDays: number): Promise<DailyClose[]> {
  const range =
    rangeDays <= 7 ? "7d" : rangeDays <= 30 ? "1mo" : rangeDays <= 92 ? "3mo" : rangeDays <= 366 ? "1y" : rangeDays <= 1830 ? "5y" : "10y";
  const body = await getJson<ChartResponse>(
    `${BASE}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`,
  );
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

// ---- option chain ----

interface OptionsResponse {
  optionChain?: {
    result?: {
      underlyingSymbol?: string;
      expirationDates?: number[];
      quote?: { currency?: string };
      options?: {
        expirationDate?: number;
        calls?: RawOption[];
        puts?: RawOption[];
      }[];
    }[];
    error?: { description?: string } | null;
  };
}
interface RawOption {
  contractSymbol?: string;
  strike?: number;
  expiration?: number;
  bid?: number;
  ask?: number;
  lastPrice?: number;
  impliedVolatility?: number;
  currency?: string;
}

function toOptionQuote(o: RawOption, type: "call" | "put", currency: string): OptionQuote | null {
  if (!o.contractSymbol || o.strike == null) return null;
  return {
    contractSymbol: o.contractSymbol,
    strike: o.strike,
    optionType: type,
    expiry: o.expiration ? isoFromUnix(o.expiration).slice(0, 10) : "",
    bid: o.bid ?? null,
    ask: o.ask ?? null,
    lastPrice: o.lastPrice ?? null,
    impliedVol: o.impliedVolatility != null ? Math.round(o.impliedVolatility * 10000) / 10000 : null,
    currency: o.currency ?? currency,
  };
}

async function optionChain(underlying: string, expiry?: string): Promise<OptionChain> {
  // Yahoo takes the expiry as a unix seconds `date` param.
  const expiryParam = expiry ? `?date=${Math.floor(Date.parse(`${expiry}T00:00:00Z`) / 1000)}` : "";
  const body = await getAuthedJson<OptionsResponse>(
    `/v7/finance/options/${encodeURIComponent(underlying)}${expiryParam}`,
  );
  const result = body.optionChain?.result?.[0];
  if (!result) throw new Error(body.optionChain?.error?.description ?? `no option chain for ${underlying}`);
  const currency = result.quote?.currency ?? "USD";
  const expiries = (result.expirationDates ?? []).map((d) => isoFromUnix(d).slice(0, 10));
  const chunk = result.options?.[0];
  const calls = (chunk?.calls ?? []).map((o) => toOptionQuote(o, "call", currency)).filter((o): o is OptionQuote => o !== null);
  const puts = (chunk?.puts ?? []).map((o) => toOptionQuote(o, "put", currency)).filter((o): o is OptionQuote => o !== null);
  return {
    underlying: result.underlyingSymbol ?? underlying,
    expiry: expiry ?? expiries[0] ?? "",
    expiries,
    currency,
    calls,
    puts,
  };
}

export const yahooProvider: MarketDataProvider = {
  name: "yahoo",
  enabled: true,
  search,
  quote,
  dailyCloses,
  optionChain,
};
