/**
 * util/retry.ts — shared retry/backoff/throttle primitives for outbound API
 * calls (Gemini, Plaid). Exponential backoff with full jitter; callers decide
 * what is retryable and may extract a server-mandated delay (e.g. Google's
 * RetryInfo, HTTP Retry-After) from the error.
 */

export interface RetryOptions {
  /** Total attempts including the first (default 4). */
  attempts?: number;
  /** First backoff delay in ms (default 1000). */
  baseDelayMs?: number;
  /** Backoff cap in ms (default 30_000). */
  maxDelayMs?: number;
  /** Return true when the error is transient and worth retrying. */
  shouldRetry: (err: unknown) => boolean;
  /** Server-mandated delay in ms for this error (overrides backoff), or null. */
  retryDelayMs?: (err: unknown) => number | null;
  /** Observability hook — called before each sleep. */
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Run `fn`, retrying transient failures with exponential backoff + full jitter. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const base = opts.baseDelayMs ?? 1000;
  const cap = opts.maxDelayMs ?? 30_000;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === attempts || !opts.shouldRetry(err)) throw err;
      const mandated = opts.retryDelayMs?.(err) ?? null;
      const backoff = Math.min(cap, base * 2 ** (attempt - 1));
      const delay = mandated ?? Math.round(Math.random() * backoff); // full jitter
      opts.onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }
  throw lastErr; // unreachable, keeps TS happy
}

/**
 * Serializing rate limiter: guarantees a minimum interval between the START
 * of consecutive calls, and runs calls one at a time (a queue, not a sieve —
 * concurrent callers line up instead of racing the interval check).
 */
export class RateLimiter {
  private nextSlot = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly minIntervalMs: number) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(async () => {
      const wait = this.nextSlot - Date.now();
      if (wait > 0) await sleep(wait);
      this.nextSlot = Date.now() + this.minIntervalMs;
      return fn();
    });
    // keep the chain alive whether or not fn rejects
    this.chain = result.catch(() => undefined);
    return result as Promise<T>;
  }
}
