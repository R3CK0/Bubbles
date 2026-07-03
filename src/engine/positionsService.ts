/**
 * engine/positionsService.ts — user-maintained portfolio state.
 * The user enters what each investment account holds; market symbols get
 * priced from stored security_prices (marketDataService keeps those fresh),
 * options/cash/other carry their user-maintained value. Daily
 * holdings_snapshots rebuild from the versioned position rows × price
 * history, so the portfolio's past reflects both market moves and position
 * changes. Reconciliation surfaces drift vs. the synced account balance —
 * keeping positions current is explicitly the user's job.
 */
import { randomUUID } from "node:crypto";
import {
  addDays,
  buildFxTable,
  roundCents,
  toCAD,
  type FxTable,
} from "../analytics/index.js";
import type { EngineContext } from "./context.js";
import { getDb } from "../db/db.js";
import {
  closePosition,
  earliestPositionDate,
  getPosition,
  insertPosition,
  listPositions,
  positionsAsOf,
  pricesRange,
  upsertSecurities,
  writeHoldingsSnapshot,
  type HoldingSnapshotWrite,
  type ManualPositionRow,
} from "../db/repositories/investments.js";
import { fxRatesRange } from "../db/repositories/history.js";
import { refreshPrices } from "./marketDataService.js";

const ASSET_TYPE_TO_SEC_TYPE: Record<ManualPositionRow["asset_type"], string> = {
  stock: "equity",
  etf: "etf",
  crypto: "crypto",
  option: "option",
  cash: "cash",
  other: "other",
};

export interface PositionInput {
  positionId?: string;
  accountId: string;
  symbol?: string | null;
  name: string;
  assetType: ManualPositionRow["asset_type"];
  quantity: number;
  bookCost?: number | null;
  manualValue?: number | null;
  currency?: string;
  effectiveDate?: string;
}

/**
 * Create or edit (versioned): editing closes the old row at the new
 * effective date and inserts a fresh one, so history rebuilds correctly.
 */
export function savePosition(input: PositionInput, today: string): ManualPositionRow {
  const effective = input.effectiveDate ?? today;
  if (input.positionId) {
    const old = getPosition(input.positionId);
    if (old) closePosition(old.position_id, effective);
  }
  const row: ManualPositionRow = {
    position_id: randomUUID(),
    account_id: input.accountId,
    symbol: input.symbol ?? null,
    name: input.name,
    asset_type: input.assetType,
    quantity: input.quantity,
    book_cost: input.bookCost ?? null,
    manual_value: input.manualValue ?? null,
    currency: input.currency ?? "CAD",
    effective_date: effective,
    end_date: null,
    created_at: new Date().toISOString(),
  };
  insertPosition(row);
  // Securities row so snapshots satisfy the FK and allocation can classify.
  const securityId = row.symbol ?? `pos:${row.position_id}`;
  upsertSecurities([
    {
      security_id: securityId,
      ticker: row.symbol,
      name: row.name,
      sec_type: ASSET_TYPE_TO_SEC_TYPE[row.asset_type],
      currency: row.currency,
      isin: null,
      raw_json: null,
    },
  ]);
  return row;
}

export function removePosition(positionId: string, endDate: string): boolean {
  return closePosition(positionId, endDate);
}

function priceOn(
  list: { date: string; close: number; currency: string }[] | undefined,
  date: string,
): { close: number; currency: string } | null {
  if (!list || list.length === 0) return null;
  let best: { close: number; currency: string } | null = null;
  for (const p of list) {
    if (p.date > date) break;
    best = { close: p.close, currency: p.currency };
  }
  return best;
}

export interface RebuildResult {
  from: string;
  to: string;
  snapshotRows: number;
}

/**
 * Rebuild daily holdings snapshots from positions × prices over [from, to].
 * Idempotent (INSERT OR REPLACE keyed on account+security+date). Values are
 * CAD at each day's FX; carry-forward pricing covers weekends/holidays.
 */
export function rebuildSnapshots(from: string, to: string): RebuildResult {
  const prices = pricesRange({ start: addDays(from, -370), end: to });
  const fx: FxTable = buildFxTable(fxRatesRange({ start: addDays(from, -370), end: to }));
  const rows: HoldingSnapshotWrite[] = [];

  for (let date = from; date <= to; date = addDays(date, 1)) {
    for (const p of positionsAsOf(date)) {
      const securityId = p.symbol ?? `pos:${p.position_id}`;
      let value: number | null = null;
      let unitPrice: number | null = null;
      if (p.symbol) {
        const price = priceOn(prices.get(p.symbol), date);
        if (!price) continue; // before first known price
        unitPrice = price.close;
        try {
          value = toCAD(p.quantity * price.close, price.currency, date, fx);
        } catch {
          value = roundCents(p.quantity * price.close); // no FX table yet: assume CAD
        }
      } else {
        const raw = p.manual_value ?? 0;
        try {
          value = toCAD(raw, p.currency, date, fx);
        } catch {
          value = roundCents(raw);
        }
      }
      rows.push({
        account_id: p.account_id,
        security_id: securityId,
        date,
        quantity: p.quantity,
        price: unitPrice,
        value,
        cost_basis: p.book_cost,
        currency: "CAD",
      });
    }
  }
  writeHoldingsSnapshot(rows);
  return { from, to, snapshotRows: rows.length };
}

/** Prices refreshed, then snapshots rebuilt from the full position horizon. */
export async function refreshAndRebuild(today: string): Promise<{ prices: Awaited<ReturnType<typeof refreshPrices>>; rebuild: RebuildResult | null }> {
  const prices = await refreshPrices(today);
  const earliest = earliestPositionDate();
  if (!earliest) return { prices, rebuild: null };
  const from = earliest > addDays(today, -1830) ? earliest : addDays(today, -1830); // 5y cap
  return { prices, rebuild: rebuildSnapshots(from, today) };
}

// ---- view + reconciliation ----

export interface PositionView extends ManualPositionRow {
  lastPrice: number | null;
  currentValue: number;
}

export interface AccountPositionsView {
  accountId: string;
  accountName: string | null;
  registeredType: string | null;
  personId: string | null;
  positions: PositionView[];
  computedTotal: number;
  reportedBalance: number | null;
  /** computed − reported: your entered positions vs. the bank's number. */
  drift: number | null;
}

export function getPositionsView(ctx: EngineContext): AccountPositionsView[] {
  const accounts = getDb()
    .prepare(
      `SELECT account_id, name, registered_type, person_id, current_balance FROM accounts
       WHERE tracked = 1 AND is_closed = 0 AND type = 'investment' ORDER BY name`,
    )
    .all() as { account_id: string; name: string | null; registered_type: string | null; person_id: string | null; current_balance: number | null }[];

  const prices = pricesRange({ start: addDays(ctx.today, -370), end: ctx.today });
  const fx = buildFxTable(fxRatesRange({ start: addDays(ctx.today, -370), end: ctx.today }));

  return accounts
    .filter((a) => ctx.lens === "combined" || a.person_id === null || a.person_id === ctx.lens)
    .map((a) => {
      const positions = listPositions(a.account_id).map((p) => {
        let lastPrice: number | null = null;
        let currentValue = 0;
        if (p.symbol) {
          const price = priceOn(prices.get(p.symbol), ctx.today);
          lastPrice = price?.close ?? null;
          if (price) {
            try {
              currentValue = toCAD(p.quantity * price.close, price.currency, ctx.today, fx);
            } catch {
              currentValue = roundCents(p.quantity * price.close);
            }
          }
        } else {
          currentValue = roundCents(p.manual_value ?? 0);
        }
        return { ...p, lastPrice, currentValue };
      });
      const computedTotal = roundCents(positions.reduce((s, p) => s + p.currentValue, 0));
      const reportedBalance = a.current_balance;
      return {
        accountId: a.account_id,
        accountName: a.name,
        registeredType: a.registered_type,
        personId: a.person_id,
        positions,
        computedTotal,
        reportedBalance,
        drift: reportedBalance !== null ? roundCents(computedTotal - reportedBalance) : null,
      };
    });
}
