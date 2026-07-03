import { describe, expect, it } from "vitest";
import { RateLimiter, withRetry } from "./retry.js";

const transient = () => Object.assign(new Error("503 UNAVAILABLE"), { status: 503 });

describe("withRetry", () => {
  it("returns the first success without retrying", async () => {
    let calls = 0;
    const result = await withRetry(async () => ++calls, { shouldRetry: () => true, baseDelayMs: 1 });
    expect(result).toBe(1);
    expect(calls).toBe(1);
  });

  it("retries transient failures until success", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw transient();
        return "ok";
      },
      { attempts: 4, baseDelayMs: 1, shouldRetry: () => true },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("fails fast on non-retryable errors", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error("401 API key not valid");
        },
        { attempts: 4, baseDelayMs: 1, shouldRetry: (e) => !/401/.test(String(e)) },
      ),
    ).rejects.toThrow("401");
    expect(calls).toBe(1);
  });

  it("gives up after the attempt budget", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw transient();
        },
        { attempts: 3, baseDelayMs: 1, shouldRetry: () => true },
      ),
    ).rejects.toThrow("503");
    expect(calls).toBe(3);
  });

  it("honors a server-mandated delay", async () => {
    let calls = 0;
    const start = Date.now();
    await withRetry(
      async () => {
        calls++;
        if (calls === 1) throw transient();
        return "ok";
      },
      { attempts: 2, baseDelayMs: 1, shouldRetry: () => true, retryDelayMs: () => 50 },
    );
    expect(Date.now() - start).toBeGreaterThanOrEqual(45);
  });
});

describe("RateLimiter", () => {
  it("spaces call starts by the minimum interval and serializes them", async () => {
    const limiter = new RateLimiter(40);
    const starts: number[] = [];
    const t0 = Date.now();
    await Promise.all(
      [1, 2, 3].map(() =>
        limiter.run(async () => {
          starts.push(Date.now() - t0);
        }),
      ),
    );
    expect(starts.length).toBe(3);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(35);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(35);
  });

  it("keeps the queue alive after a rejection", async () => {
    const limiter = new RateLimiter(1);
    await expect(limiter.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(limiter.run(async () => "still works")).resolves.toBe("still works");
  });
});
