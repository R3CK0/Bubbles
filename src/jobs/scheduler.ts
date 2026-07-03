/**
 * jobs/scheduler.ts — in-process scheduling, no cron dependency: a setTimeout
 * chain targeting 03:30 local, plus a boot catch-up when the last successful
 * run is stale. The monthly report job joins in step 4.
 */
import type { Vault } from "../vault/vault.js";
import { runNightly } from "./nightly.js";
import { lastSuccessfulRun } from "../db/repositories/ops.js";

const NIGHTLY_HOUR = 3;
const NIGHTLY_MINUTE = 30;

function msUntilNextNightly(now: Date): number {
  const next = new Date(now);
  next.setHours(NIGHTLY_HOUR, NIGHTLY_MINUTE, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

let running = false;

async function fire(vault: Vault | null, reason: string): Promise<void> {
  if (running) return;
  running = true;
  try {
    const { status } = await runNightly(vault);
    console.log(`[jobs] nightly run (${reason}) finished: ${status}`);
  } catch (err) {
    console.error(`[jobs] nightly run (${reason}) crashed:`, err);
  } finally {
    running = false;
  }
}

/** Call once after the server starts. Takes a getter, not a vault: the vault
 *  can appear at RUNTIME via a session grant, and the nightly must see it.
 *  Timers are unref'd so they never hold the process open. */
export function startScheduler(getVault: () => Vault | null): void {
  const scheduleNext = () => {
    const delay = msUntilNextNightly(new Date());
    const timer = setTimeout(async () => {
      await fire(getVault(), "scheduled");
      scheduleNext();
    }, delay);
    timer.unref();
    console.log(`[jobs] next nightly run in ${Math.round(delay / 60_000)} min`);
  };
  scheduleNext();

  // Boot catch-up: if the last successful run is older than 24h, run soon.
  const last = lastSuccessfulRun();
  const stale = !last || Date.now() - new Date(last.started_at).getTime() > 24 * 3600_000;
  if (stale) {
    const timer = setTimeout(() => void fire(getVault(), "boot catch-up"), 10_000);
    timer.unref();
    console.log("[jobs] last sync run is stale — catch-up scheduled in 10s");
  }
}
