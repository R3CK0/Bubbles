/**
 * db/repositories/history.ts — data access for balance snapshots, manual
 * assets, and FX rates.
 */
import { randomUUID } from "node:crypto";
import { getDb } from "../db.js";
import type { FxRate } from "../../analytics/types.js";

export interface AccountSnapshotRow {
  account_id: string;
  date: string;
  current_balance: number | null;
  available_balance: number | null;
  currency: string;
}

/** Snapshot every tracked open account's current balances for `date`. Idempotent. */
export function writeAccountSnapshots(date: string): number {
  return getDb()
    .prepare(
      `INSERT OR REPLACE INTO account_snapshots (account_id, date, current_balance, available_balance, currency)
       SELECT account_id, ?, current_balance, available_balance, COALESCE(iso_currency_code, 'CAD')
       FROM accounts WHERE tracked = 1 AND is_closed = 0`,
    )
    .run(date).changes;
}

export function snapshotRange(range: { start: string; end: string }): AccountSnapshotRow[] {
  return getDb()
    .prepare(`SELECT * FROM account_snapshots WHERE date >= ? AND date <= ? ORDER BY date`)
    .all(range.start, range.end) as AccountSnapshotRow[];
}

export function latestSnapshotDate(): string | null {
  const row = getDb().prepare(`SELECT MAX(date) AS d FROM account_snapshots`).get() as { d: string | null };
  return row.d;
}

// ---- manual assets ----

export interface ManualAssetRow {
  asset_id: string;
  person_id: string | null;
  name: string;
  asset_class: "real_estate" | "vehicle" | "private_equity" | "collectible" | "other";
  currency: string;
  notes: string | null;
  archived: number;
}

export function listManualAssets(includeArchived = false): ManualAssetRow[] {
  const where = includeArchived ? "" : "WHERE archived = 0";
  return getDb().prepare(`SELECT * FROM manual_assets ${where} ORDER BY name`).all() as ManualAssetRow[];
}

export function createManualAsset(
  input: Omit<ManualAssetRow, "asset_id" | "archived"> & { assetId?: string },
): ManualAssetRow {
  const row: ManualAssetRow = {
    asset_id: input.assetId ?? randomUUID(),
    person_id: input.person_id,
    name: input.name,
    asset_class: input.asset_class,
    currency: input.currency,
    notes: input.notes,
    archived: 0,
  };
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO manual_assets (asset_id, person_id, name, asset_class, currency, notes, archived)
       VALUES (@asset_id, @person_id, @name, @asset_class, @currency, @notes, @archived)`,
    )
    .run(row);
  return row;
}

export function addValuation(assetId: string, date: string, value: number, source: string | null): void {
  getDb()
    .prepare(`INSERT OR REPLACE INTO manual_asset_valuations (asset_id, date, value, source) VALUES (?, ?, ?, ?)`)
    .run(assetId, date, value, source);
}

export function valuations(assetId: string): { date: string; value: number; source: string | null }[] {
  return getDb()
    .prepare(`SELECT date, value, source FROM manual_asset_valuations WHERE asset_id = ? ORDER BY date`)
    .all(assetId) as { date: string; value: number; source: string | null }[];
}

export function allValuations(): { asset_id: string; date: string; value: number }[] {
  return getDb()
    .prepare(`SELECT asset_id, date, value FROM manual_asset_valuations ORDER BY date`)
    .all() as { asset_id: string; date: string; value: number }[];
}

// ---- fx ----

export function upsertFxRates(rows: FxRate[]): number {
  const stmt = getDb().prepare(
    `INSERT OR REPLACE INTO fx_rates (date, base_ccy, quote_ccy, rate) VALUES (?, ?, ?, ?)`,
  );
  const run = getDb().transaction((all: FxRate[]) => {
    for (const r of all) stmt.run(r.date, r.baseCcy, r.quoteCcy, r.rate);
  });
  run(rows);
  return rows.length;
}

export function fxRatesRange(range: { start: string; end: string }): FxRate[] {
  const rows = getDb()
    .prepare(`SELECT date, base_ccy, quote_ccy, rate FROM fx_rates WHERE date >= ? AND date <= ? ORDER BY date`)
    .all(range.start, range.end) as { date: string; base_ccy: string; quote_ccy: string; rate: number }[];
  return rows.map((r) => ({ date: r.date, baseCcy: r.base_ccy, quoteCcy: r.quote_ccy, rate: r.rate }));
}

export function latestFxDate(base: string, quote: string): string | null {
  const row = getDb()
    .prepare(`SELECT MAX(date) AS d FROM fx_rates WHERE base_ccy = ? AND quote_ccy = ?`)
    .get(base, quote) as { d: string | null };
  return row.d;
}

/** True when any tracked account holds a non-CAD currency (FX fetch needed). */
export function hasNonCadAccounts(): boolean {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM accounts WHERE tracked = 1 AND is_closed = 0 AND iso_currency_code IS NOT NULL AND iso_currency_code != 'CAD'`,
    )
    .get() as { n: number };
  return row.n > 0;
}
