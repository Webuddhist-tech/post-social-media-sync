import type { AccountService } from "./accounts.js";
import type { Config } from "./config.js";
import type { PostSyncEmitter } from "./events.js";
import { ApiError, AuthError, RefreshAuthError, sleep as realSleep, UserError } from "./http.js";
import { errorText, type Logger } from "./logger.js";
import type { MediaStore } from "./media.js";
import { getPlatform } from "./platforms/index.js";
import type { PublishContext, PublishResult } from "./platforms/types.js";
import type { PostService } from "./posts.js";
import type { Storage, TargetRow } from "./storage/types.js";

const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
/** A running job's lease; renewed every HEARTBEAT_MS. If a process dies, others take over after the lease expires. */
const LEASE_MS = 2 * 60_000;
const HEARTBEAT_MS = 30_000;
/** Waits between attempts to record a job's outcome while the database fails (about 15 s in all). */
const RECORD_RETRY_MS = [500, 1000, 2000, 4000, 8000];
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
  /** Claims waiting for the database, and the slots they reserved (so overlapping claims respect the concurrency). */
  private claiming = new Set<Promise<TargetRow[]>>();
  private reserved = 0;
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
    this.timers.push(setInterval(() => void this.tick(), this.deps.pollIntervalMs ?? 2000));
    this.timers.push(setInterval(() => void this.heartbeat(), HEARTBEAT_MS));
    this.timers.push(setInterval(() => void this.maintainTokens(), 6 * 3600_000));
    this.timers.push(setInterval(() => void this.cleanupMedia(), 3600_000));
    for (const t of this.timers) t.unref?.();
    void this.maintainTokens();
    void this.tick();
  }

  /** Stops polling and waits (up to `timeoutMs`) for a claim in progress and for the running jobs to finish. */
  async stop(timeoutMs = 30_000): Promise<void> {
    this.started = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    // Keep the leases alive meanwhile, or other processes would take these jobs for dead.
    const heartbeat = setInterval(() => void this.heartbeat(), HEARTBEAT_MS);
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)));
    try {
      await Promise.race([this.idle(), timedOut]);
    } finally {
      clearTimeout(timer);
      clearInterval(heartbeat);
    }
  }

  /** Looks for due jobs now (e.g. right after a post is created). */
  kick(): void {
    if (this.started) void this.tick();
  }

  /**
   * Runs every job that is due right now and waits for them to finish. Use this instead of `start()` when your own
   * scheduler (cron, a job queue, a serverless timer) should drive publishing. Call `maintain()` from your scheduler
   * too (e.g. hourly).
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
        if (!jobs.length && !this.busy) break;
        await this.idle();
        if (!jobs.length) break;
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
    return { processed };
  }

  /**
   * Refreshes long-lived tokens, flags expired logins and deletes uploads no post uses (older than a day), once.
   * `start()` does this on timers; call it yourself when you drive publishing with `runDue()`.
   */
  async maintain(): Promise<{ cleanedMedia: number }> {
    await this.deps.accounts.maintain();
    return { cleanedMedia: await this.deps.media.cleanupOrphans() };
  }

  /** Resolves once no claim is in progress and every job running in this process has finished. */
  async idle(): Promise<void> {
    while (this.busy) await Promise.allSettled([this.ticking, ...this.claiming, ...this.running.values()]);
  }

  private get busy(): boolean {
    return this.ticking !== null || this.claiming.size > 0 || this.running.size > 0;
  }

  private async tick(): Promise<void> {
    if (!this.started || this.ticking) return;
    this.ticking = (async () => {
      try {
        await this.recoverInterrupted();
        // stop() may have been called meanwhile: start nothing new then.
        if (this.started) await this.claim();
      } catch (err) {
        this.deps.log.error(`worker tick failed: ${errorText(err)}`, err);
      }
    })();
    try {
      await this.ticking;
    } finally {
      this.ticking = null;
    }
  }

  private async maintainTokens(): Promise<void> {
    await this.deps.accounts.maintain().catch((err) => this.deps.log.error(`token maintenance failed: ${errorText(err)}`, err));
  }

  private async cleanupMedia(): Promise<void> {
    await this.deps.media.cleanupOrphans().catch((err) => this.deps.log.error(`media cleanup failed: ${errorText(err)}`, err));
  }

  private async claim(): Promise<TargetRow[]> {
    // Reserve the slots before waiting for the database: overlapping claims must not exceed the concurrency.
    const free = this.deps.config.workerConcurrency - this.running.size - this.reserved;
    if (free <= 0) return [];
    this.reserved += free;
    const claim = (async () => {
      const now = Date.now();
      const jobs = await this.deps.db.claimDueTargets(free, now, now + LEASE_MS);
      for (const target of jobs) this.launch(target);
      return jobs;
    })();
    this.claiming.add(claim);
    try {
      return await claim;
    } finally {
      this.reserved -= free;
      this.claiming.delete(claim);
    }
  }

  private launch(target: TargetRow): void {
    const job = this.run(target)
      .catch((err) => {
        try {
          this.deps.log.error(`publish job ${target.id} (${target.platform}) failed unexpectedly: ${errorText(err)}`, err);
        } catch {
          // a broken logger must not turn into an unhandled rejection
        }
      })
      .finally(() => {
        this.running.delete(target.id);
        if (this.started) void this.tick();
      });
    this.running.set(target.id, job);
  }

  private async renewLeases(): Promise<void> {
    if (this.running.size) await this.deps.db.renewLeases([...this.running.keys()], Date.now() + LEASE_MS);
  }

  private async heartbeat(): Promise<void> {
    try {
      await this.renewLeases();
    } catch (err) {
      this.deps.log.error(`lease renewal failed: ${errorText(err)}`, err);
    }
  }

  /** Jobs whose process died mid-way. Not retried blindly: the post may already be live. */
  private async recoverInterrupted(): Promise<void> {
    // Our own jobs first: a late heartbeat (busy event loop, slow database) must not make us fail jobs still running here.
    await this.renewLeases();
    const failed = await this.deps.db.failExpiredLeases(Date.now(), INTERRUPTED);
    for (const t of failed) {
      this.deps.log.warn(`publish job ${t.id} (${t.platform}) was interrupted and marked failed`);
      this.deps.events.emit("target.failed", { target: this.deps.posts.targetToPublic(t), error: INTERRUPTED, willRetry: false, retryAt: null });
    }
  }

  private async run(target: TargetRow): Promise<void> {
    this.deps.events.emit("target.started", { target: this.deps.posts.targetToPublic(target) });
    let result: PublishResult;
    try {
      result = await this.publish(target);
    } catch (err) {
      // Only errors up to and including the publish request get here: nothing after it may mark the job failed.
      await this.fail(target, err);
      return;
    }
    await this.succeed(target, result);
  }

  private async publish(target: TargetRow): Promise<PublishResult> {
    const { db, log, accounts, posts, config, media, events } = this.deps;
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
        db.setTargetProgress(target.id, message).catch((err) => log.error(`progress update failed: ${errorText(err)}`, err));
        events.emit("target.progress", { target: { ...posts.targetToPublic(target), progress: message }, message });
      },
      sleep: this.deps.sleep ?? realSleep,
    };

    log.info(`publishing to ${target.platform}/${target.account_name} (attempt ${target.attempts})`);
    return platform.publish(ctx);
  }

  /** The post is live: record it, retrying through database errors (marking it failed would invite a duplicate). */
  private async succeed(target: TargetRow, result: PublishResult): Promise<void> {
    const { db, log, posts, events } = this.deps;
    const label = `${target.platform}/${target.account_name}`;
    const note = result.note ?? null;
    const recorded = await this.record(`record that ${label} published ${result.url ?? result.remoteId}`, () =>
      db.completeTarget(target.id, result.remoteId, result.url, note),
    );
    if (!recorded) return;
    log.info(`published to ${label}: ${result.url ?? result.remoteId}`);
    const now = Date.now();
    const done = (await db.getTarget(null, target.id).catch(() => undefined)) ?? {
      ...target,
      status: "succeeded" as const,
      remote_id: result.remoteId,
      remote_url: result.url,
      progress: note,
      error: null,
      lease_until: null,
      finished_at: now,
      updated_at: now,
    };
    events.emit("target.succeeded", { target: posts.targetToPublic(done) });
  }

  /** Records a failed attempt: queued again after a temporary error, failed for good otherwise. */
  private async fail(target: TargetRow, err: unknown): Promise<void> {
    const { db, log, accounts, posts, config, events } = this.deps;
    const label = `${target.platform}/${target.account_name}`;
    const message = err instanceof Error ? err.message : String(err);
    // A rejected refresh has flagged the account already.
    if (err instanceof AuthError && !(err instanceof RefreshAuthError)) {
      try {
        const account = await db.getAccount(null, target.account_id);
        if (account) await accounts.markNeedsReconnect(account, message);
      } catch (e) {
        log.error(`couldn't flag ${label} for reconnecting: ${errorText(e)}`, e);
      }
    }

    const retryable = err instanceof ApiError && err.retryable;
    let retryAt: number | null = null;
    let error = message;
    if (retryable && target.attempts < config.maxAttempts) {
      // Wait at least as long as the platform asked (rate-limit reset), but no more than a day.
      const fixed = RETRY_DELAYS_MS[Math.min(target.attempts - 1, RETRY_DELAYS_MS.length - 1)];
      const delay = Math.min(Math.max(fixed, (err as ApiError).retryAfterMs ?? 0), 24 * 3600_000);
      retryAt = Date.now() + delay + 1000;
      error = `${message} — retrying in ${formatDelay(delay)}`;
    }
    let updated = false;
    const recorded = await this.record(`record that publishing to ${label} failed (${message})`, async () => {
      updated = await db.failTarget(target.id, error, retryAt);
    });
    if (!recorded) return;
    if (!updated) {
      // Its lease ran out and another process reported it already.
      log.warn(`publishing to ${label} failed after the job was already finished elsewhere: ${message}`);
      return;
    }
    if (retryAt !== null) log.warn(`publishing to ${label} failed, will retry: ${message}`);
    else log.error(`publishing to ${label} failed: ${message}`);

    const after = await db.getTarget(null, target.id).catch(() => undefined);
    events.emit("target.failed", {
      target: posts.targetToPublic(after ?? { ...target, status: retryAt !== null ? "queued" : "failed", error }),
      error: message,
      willRetry: retryAt !== null,
      retryAt,
    });
  }

  /**
   * Writes a job's outcome, retrying while the database fails. When it can't, the job stays running and lease
   * recovery reports it as interrupted once its lease runs out. Returns whether it was written.
   */
  private async record(what: string, write: () => Promise<unknown>): Promise<boolean> {
    const wait = this.deps.sleep ?? realSleep;
    for (let attempt = 0; ; attempt++) {
      try {
        await write();
        return true;
      } catch (err) {
        if (attempt >= RECORD_RETRY_MS.length) {
          this.deps.log.error(`couldn't ${what}: ${errorText(err)}. It will be reported as interrupted when its lease runs out.`, err);
          return false;
        }
        await wait(RECORD_RETRY_MS[attempt]);
      }
    }
  }
}
