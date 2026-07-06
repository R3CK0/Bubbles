/**
 * jobs/intradayQuotes.ts — the live (5-min) portfolio refresh. Fetches current
 * quotes for held symbols, caches them (security_quotes), folds the live price
 * into today's security_prices and rebuilds today's holdings snapshot, so every
 * account's value on the Investments/Overview pages moves intraday.
 *
 * Market-hours gating keeps the polling polite: the household is in Québec
 * (Eastern), so the local clock IS the exchange clock. Crypto trades 24/7, FX
 * ~24/5, everything else (stocks/ETFs/options/commodities) only during the
 * 9:30–16:00 ET regular session. When nothing is eligible the job no-ops.
 */
import type { ManualPositionRow } from "../db/repositories/investments.js";
import { activePositionSymbols } from "../db/repositories/investments.js";
import { refreshLiveAndRebuild } from "../engine/positionsService.js";

type Held = { symbol: string; asset_type: ManualPositionRow["asset_type"] };

/** Symbols worth quoting at `now`, filtered by each asset class's session. */
export function eligibleSymbols(now: Date, held: Held[]): string[] {
  const day = now.getDay(); // 0 Sun … 6 Sat
  const minutes = now.getHours() * 60 + now.getMinutes();
  const weekday = day >= 1 && day <= 5;
  const equityOpen = weekday && minutes >= 9 * 60 + 30 && minutes <= 16 * 60;
  // FX runs from Sunday ~17:00 through Friday close — approximate as weekdays
  // plus Sunday evening.
  const fxOpen = weekday || (day === 0 && minutes >= 17 * 60);
  return held
    .filter(({ asset_type }) => {
      if (asset_type === "crypto") return true;
      if (asset_type === "currency") return fxOpen;
      return equityOpen; // stock / etf / option / commodity
    })
    .map((h) => h.symbol);
}

export interface IntradayResult {
  eligible: number;
  quoted: number;
  asOf: string | null;
  skipped?: string;
}

/** One intraday tick. Safe to call when the market is closed (it no-ops). */
export async function runIntradayQuotes(now = new Date()): Promise<IntradayResult> {
  const held = activePositionSymbols();
  const symbols = eligibleSymbols(now, held);
  if (symbols.length === 0) {
    return { eligible: 0, quoted: 0, asOf: null, skipped: held.length === 0 ? "no symbols held" : "market closed" };
  }
  const today = now.toISOString().slice(0, 10);
  const result = await refreshLiveAndRebuild(today, symbols);
  return { eligible: symbols.length, quoted: result.quoted, asOf: result.asOf };
}
