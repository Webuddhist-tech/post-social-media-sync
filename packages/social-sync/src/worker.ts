import type { AccountService } from "./accounts.js";
import type { Config } from "./config.js";
import type { PostSyncEmitter } from "./events.js";
import { ApiError, AuthError, sleep as realSleep, UserError } from "./http.js";
import type { Logger } from "./logger.js";
import type { MediaStore } from "./media.js";
import { getPlatform } from "./platforms/index.js";
import type { PublishContext } from "./platforms/types.js";
import type { PostService } from "./posts.js";
import type { Storage, TargetRow } from "./storage/types.js";

const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
/** A running job's lease; renewed every HEARTBEAT_MS. If a process dies, others take over after the lease expires. */
const LEASE_MS = 2 * 60_000;
const HEARTBEAT_MS = 30_000;
const INTERRUPTED =
  "Interrupted because the server running it stopped. Check the platform before retrying: the post may already be live.";

export interface WorkerDeps {
  db: Storage;
  config: Config;
  accounts: AccountService;
  posts: PostService;
  media: MediaStore;
  events: PostSyncEmitter;
  log: Logger;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
}

function formatDelay(ms: number): string {
  const min = Math.round(ms / 60_000);
  return min < 60 ? `${Math.max(1, min)} min` : `${Math.round(min / 60)} h`;
}

/**
 * Runs queued publish jobs. Safe to run in several processes against the same database: claiming is atomic and
 * a database rule allows only one running job per account.
 */
export class Worker {
  private running = new Map<string, Promise<void>>(); // targetId -> job
  private timers: NodeJS.Timeout[] = [];
  private started = false;
  private ticking: Promise<void> | null = null;

  constructor(private readonly deps: WorkerDeps) {}

  get isRunning(): boolean {
    return this.started;
  }

  /** Starts polling for due jobs in this process. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const { log, accounts, media } = this.deps;
    this.timers.push(setInterval(() => void this.tick(), this.deps.pollIntervalMs ?? 2000));
    this.timers.push(setInterval(() => void this.heartbeat(), HEARTBEAT_MS));
    this.timers.push(setInterval(() => void accounts.maintain().catch((e) => log.error("token maintenance failed", e)), 6 * 3600_000));
    this.timers.push(setInterval(() => void media.cleanupOrphans().catch((e) => log.error("media cleanup failed", e)), 3600_000));
    for (const t of this.timers) t.unref?.();
    void accounts.maintain().catch((e) => log.error("token maintenance failed", e));
    void this.tick();
  }

  /** Stops polling and waits (up to `timeoutMs`) for running jobs to finish. */
  async stop(timeoutMs = 30_000): Promise<void> {
    this.started = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await Promise.race([Promise.allSettled([...this.running.values()]), realSleep(timeoutMs)]);
  }

  /** Looks for due jobs now (e.g. right after a post is created). */
  kick(): void {
    if (this.started) void this.tick();
  }

  /**
   * Runs every job that is due right now and waits for them to finish. Use this instead of `start()` when your own
   * scheduler (cron, a job queue, a serverless timer) should drive publishing.
   */
  async runDue(): Promise<{ processed: number }> {
    let processed = 0;
    // Keep leases alive while we work, or other processes would think these jobs died.
    const heartbeat = this.started ? null : setInterval(() => void this.heartbeat(), HEARTBEAT_MS);
    try {
      for (;;) {
        await this.recoverInterrupted();
        const jobs = await this.claim();
        processed += jobs.length;
        if (!jobs.length && !this.running.size) break;
        await this.idle();
        if (!jobs.length) break;
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
    return { processed };
  }

  /** Resolves once every job running in this process has finished. */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running.values()]);
  }

  private async tick(): Promise<void> {
    if (!this.started || this.ticking) return;
    this.ticking = (async () => {
      try {
        await this.recoverInterrupted();
        await this.claim();
      } catch (err) {
        this.deps.log.error("worker tick failed", err);
      }
    })();
    try {
      await this.ticking;
    } finally {
      this.ticking = null;
    }
  }

  private async claim(): Promise<TargetRow[]> {
    const free = this.deps.config.workerConcurrency - this.running.size;
    if (free <= 0) return [];
    const now = Date.now();
    const jobs = await this.deps.db.claimDueTargets(free, now, now + LEASE_MS);
    for (const target of jobs) {
      const job = this.run(target).finally(() => {
        this.running.delete(target.id);
        if (this.started) void this.tick();
      });
      this.running.set(target.id, job);
    }
    return jobs;
  }

  private async heartbeat(): Promise<void> {
    try {
      await this.deps.db.renewLeases([...this.running.keys()], Date.now() + LEASE_MS);
    } catch (err) {
      this.deps.log.error("lease renewal failed", err);
    }
  }

  /** Jobs whose process died mid-way. Not retried blindly: the post may already be live. */
  private async recoverInterrupted(): Promise<void> {
    const failed = await this.deps.db.failExpiredLeases(Date.now(), INTERRUPTED);
    for (const t of failed) {
      this.deps.log.warn(`publish job ${t.id} (${t.platform}) was interrupted and marked failed`);
      this.deps.events.emit("target.failed", { target: this.deps.posts.targetToPublic(t), error: INTERRUPTED, willRetry: false, retryAt: null });
    }
  }

  private async run(target: TargetRow): Promise<void> {
    const { db, log, accounts, posts, config, media, events } = this.deps;
    const label = `${target.platform}/${target.account_name}`;
    events.emit("target.started", { target: posts.targetToPublic(target) });
    try {
      const platform = getPlatform(target.platform);
      const post = await db.getPost(target.owner_id, target.post_id);
      const account = await db.getAccount(target.owner_id, target.account_id);
      if (!platform || !post) throw new UserError("This post no longer exists.");
      if (!account) throw new UserError("The account was disconnected. Reconnect it and retry.");

      let lastProgress = "";
      const ctx: PublishContext = {
        account: accounts.info(account),
        input: await posts.inputFor(target, post),
        config,
        media,
        credentials: (opts) => accounts.credentials(account.id, opts),
        progress: (message) => {
          if (message === lastProgress) return;
          lastProgress = message;
          db.setTargetProgress(target.id, message).catch((e) => log.error("progress update failed", e));
          events.emit("target.progress", { target: { ...posts.targetToPublic(target), progress: message }, message });
        },
        sleep: this.deps.sleep ?? realSleep,
      };

      log.info(`publishing to ${label} (attempt ${target.attempts})`);
      const result = await platform.publish(ctx);
      await db.completeTarget(target.id, result.remoteId, result.url, result.note ?? null);
      log.info(`published to ${label}: ${result.url ?? result.remoteId}`);
      const done = await db.getTarget(null, target.id);
      if (done) events.emit("target.succeeded", { target: posts.targetToPublic(done) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof AuthError) {
        const account = await db.getAccount(null, target.account_id).catch(() => undefined);
        if (account) await accounts.markNeedsReconnect(account, message).catch(() => {});
      }
      const retryable = err instanceof ApiError && err.retryable;
      let retryAt: number | null = null;
      if (retryable && target.attempts < config.maxAttempts) {
        // Wait at least as long as the platform asked (rate-limit reset), but no more than a day.
        const fixed = RETRY_DELAYS_MS[Math.min(target.attempts - 1, RETRY_DELAYS_MS.length - 1)];
        const delay = Math.min(Math.max(fixed, (err as ApiError).retryAfterMs ?? 0), 24 * 3600_000);
        retryAt = Date.now() + delay + 1000;
        await db.failTarget(target.id, `${message} — retrying in ${formatDelay(delay)}`, retryAt);
        log.warn(`publishing to ${label} failed, will retry: ${message}`);
      } else {
        await db.failTarget(target.id, message, null);
        log.error(`publishing to ${label} failed: ${message}`);
      }
      const after = await db.getTarget(null, target.id).catch(() => undefined);
      events.emit("target.failed", {
        target: posts.targetToPublic(after ?? { ...target, status: "failed", error: message }),
        error: message,
        willRetry: retryAt !== null,
        retryAt,
      });
    }
  }
}
