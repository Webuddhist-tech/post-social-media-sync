import { ApiError, AuthError, RefreshAuthError } from "../http.js";
import type { PublishContext } from "./types.js";

export interface PollOptions {
  intervalMs: number;
  timeoutMs: number;
  /** Upper bound for the growing wait between checks (default 30 s). */
  maxIntervalMs?: number;
  what: string;
  /**
   * Keep polling through temporary errors (network, 5xx, 429) instead of failing. Use this once the platform
   * already has the post: failing here would make the queue start over and publish it twice.
   */
  tolerateTransientErrors?: boolean;
  /** Let the queue retry after a timeout. Only for waits that happen before anything is published. */
  retryableTimeout?: boolean;
}

/** Polls `check` until it returns a value, or throws after `timeoutMs`. */
export async function pollUntil<T>(sleep: (ms: number) => Promise<void>, check: () => Promise<T | null>, opts: PollOptions): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs;
  let interval = opts.intervalMs;
  let failures = 0;
  for (;;) {
    let result: T | null = null;
    try {
      result = await check();
      failures = 0;
    } catch (err) {
      const transient = err instanceof ApiError && err.retryable;
      if (!opts.tolerateTransientErrors || !transient || ++failures > 20) throw err;
    }
    if (result !== null) return result;
    if (Date.now() > deadline) {
      throw new ApiError(`Timed out after ${Math.round(opts.timeoutMs / 60000)} min waiting for ${opts.what}`, 0, null, !!opts.retryableTimeout);
    }
    await sleep(interval);
    interval = Math.min(interval * 1.5, opts.maxIntervalMs ?? 30_000);
  }
}

/**
 * Runs `fn` with a current access token. If the platform answers 401 (e.g. the token expired during a long
 * upload), forces one refresh and tries once more before giving up. A rejected refresh is final: refreshing again
 * would only be rejected again.
 */
export async function withFreshToken<T>(ctx: PublishContext, pick: (credentials: any) => string, fn: (token: string) => Promise<T>): Promise<T> {
  try {
    return await fn(pick(await ctx.credentials()));
  } catch (err) {
    if (!(err instanceof AuthError) || err instanceof RefreshAuthError) throw err;
    return fn(pick(await ctx.credentials({ force: true })));
  }
}
