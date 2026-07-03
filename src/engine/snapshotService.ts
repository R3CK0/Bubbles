/**
 * engine/snapshotService.ts — the nightly write path for history tables.
 * No HTTP surface: called by jobs/nightly.ts (and post-link, later).
 */
import { writeAccountSnapshots } from "../db/repositories/history.js";
import { refreshBalancesFromAccounts } from "../db/repositories/debts.js";

export interface SnapshotResult {
  accountsSnapshotted: number;
  debtBalancesRefreshed: number;
}

/** Idempotent for a given date (INSERT OR REPLACE keyed on account+date). */
export function snapshotAccounts(date: string): SnapshotResult {
  const debtBalancesRefreshed = refreshBalancesFromAccounts();
  const accountsSnapshotted = writeAccountSnapshots(date);
  return { accountsSnapshotted, debtBalancesRefreshed };
}
