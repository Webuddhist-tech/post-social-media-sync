import type { FastifyBaseLogger } from "fastify";
import type { AccountService } from "./accounts.js";
import type { Config } from "./config.js";
import type { DB, TargetRow } from "./db.js";
import { ApiError, AuthError, sleep as realSleep, UserError } from "./http.js";
import type { MediaStore } from "./media.js";
import { getPlatform } from "./platforms/index.js";
import type { PublishContext } from "./platforms/types.js";
import type { PostService } from "./posts.js";

const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

export interface WorkerDeps {
  db: DB;
  config: Config;
  accounts: AccountService;
  posts: PostService;
  media: MediaStore;
  log: FastifyBaseLogger;
  sleep?: (ms: number) => Promise<void>;
  tickMs?: number;
}

function formatDelay(ms: number): string {
  const min = Math.round(ms / 60_000);
  return min < 60 ? `${Math.max(1, min)} min` : `${Math.round(min / 60)} h`;
}

/** Runs queued publish jobs in the background, one job per account at a time. */
export class Worker {
  private running = new Map<string, Promise<void>>(); // targetId -> job
  private runningAccounts = new Set<string>();
  private timers: NodeJS.Timeout[] = [];
  private stopped = true;
  private ticking = false;

  constructor(private readonly deps: WorkerDeps) {}

  start(): void {
    const { db, log, accounts, media } = this.deps;
    this.stopped = false;
    const interrupted = db.failInterruptedTargets();
    if (interrupted) log.warn(`${interrupted} publish job(s) were interrupted by a restart and marked failed`);

    this.timers.push(setInterval(() => void this.tick(), this.deps.tickMs ?? 2000));
    this.timers.push(setInterval(() => void accounts.maintain().catch((e) => log.error(e, "token maintenance failed")), 6 * 3600_000));
    this.timers.push(setInterval(() => void media.cleanupOrphans().catch((e) => log.error(e, "media cleanup failed")), 3600_000));
    void accounts.maintain().catch((e) => log.error(e, "token maintenance failed"));
    void this.tick();
  }

  async stop(timeoutMs = 30_000): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await Promise.race([Promise.allSettled([...this.running.values()]), realSleep(timeoutMs)]);
  }

  /** Checks for due jobs now (called after a post is created). */
  kick(): void {
    void this.tick();
  }

  /** Resolves once every currently running job has finished (used by tests). */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running.values()]);
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      const free = this.deps.config.workerConcurrency - this.running.size;
      if (free <= 0) return;
      const jobs = this.deps.db.claimDueTargets(free, [...this.runningAccounts]);
      for (const target of jobs) {
        this.runningAccounts.add(target.account_id);
        const job = this.run(target).finally(() => {
          this.running.delete(target.id);
          this.runningAccounts.delete(target.account_id);
          if (!this.stopped) void this.tick();
        });
        this.running.set(target.id, job);
      }
    } catch (err) {
      this.deps.log.error(err, "worker tick failed");
    } finally {
      this.ticking = false;
    }
  }

  private async run(target: TargetRow): Promise<void> {
    const { db, log, accounts, posts, config, media } = this.deps;
    const label = `${target.platform}/${target.account_name}`;
    try {
      const platform = getPlatform(target.platform);
      const post = db.getPost(target.post_id);
      const account = db.getAccount(target.account_id);
      if (!platform || !post) throw new UserError("This post no longer exists.");
      if (!account) throw new UserError("The account was disconnected. Reconnect it and retry.");

      let lastProgress = "";
      const ctx: PublishContext = {
        account: accounts.info(account),
        input: posts.inputFor(target, post),
        config,
        media,
        credentials: (opts) => accounts.credentials(account.id, opts),
        progress: (message) => {
          if (message === lastProgress) return;
          lastProgress = message;
          db.setTargetProgress(target.id, message);
        },
        sleep: this.deps.sleep ?? realSleep,
      };

      log.info({ target: target.id, attempt: target.attempts }, `publishing to ${label}`);
      const result = await platform.publish(ctx);
      db.completeTarget(target.id, result.remoteId, result.url, result.note ?? null);
      log.info({ target: target.id, url: result.url }, `published to ${label}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof AuthError) {
        db.markAccountNeedsReauth(target.account_id, message);
      }
      const retryable = err instanceof ApiError && err.retryable && !(err instanceof UserError);
      if (retryable && target.attempts < config.maxAttempts) {
        // Wait at least as long as the platform asked (rate-limit reset), but no more than a day.
        const fixed = RETRY_DELAYS_MS[Math.min(target.attempts - 1, RETRY_DELAYS_MS.length - 1)];
        const delay = Math.min(Math.max(fixed, (err as ApiError).retryAfterMs ?? 0), 24 * 3600_000);
        db.failTarget(target.id, `${message} — retrying in ${formatDelay(delay)}`, Date.now() + delay + 1000);
        log.warn({ target: target.id, err: message }, `publishing to ${label} failed, will retry`);
      } else {
        db.failTarget(target.id, message, null);
        log.error({ target: target.id, err: message }, `publishing to ${label} failed`);
      }
    }
  }
}
