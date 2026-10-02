import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { AccountService } from "./accounts.js";
import { isPrivateBaseUrl, resolvePlatformKeys, type Config, type PlatformKeys } from "./config.js";
import { pkceChallenge, randomToken, Secrets } from "./crypto.js";
import { PostSyncEmitter } from "./events.js";
import { AuthError, UserError } from "./http.js";
import { consoleLogger, silentLogger, type Logger } from "./logger.js";
import { hasFfmpeg, MediaStore, SUPPORTED_MIME_TYPES } from "./media.js";
import { CONNECTORS, getConnector, getPlatform, PLATFORMS } from "./platforms/index.js";
import { parsePostRequest, PostService } from "./posts.js";
import type { Storage } from "./storage/types.js";
import type {
  CheckResult,
  ConnectorId,
  Description,
  PlatformId,
  PostPage,
  PostRequest,
  PostSyncEventName,
  PostSyncEvents,
  PublicAccount,
  PublicMedia,
  PublicPost,
  TargetIssue,
} from "./types.js";
import { Worker } from "./worker.js";

export interface PostSyncOptions {
  /**
   * Secret of 32+ characters. Encrypts the stored platform tokens and signs media URLs.
   * Keep it stable: changing it makes saved logins unreadable.
   */
  secret: string;
  /**
   * Absolute URL where you mount the HTTP handler, e.g. "https://api.example.com/social".
   * OAuth redirect URIs (`<publicUrl>/oauth/<connector>/callback`) and media URLs (`<publicUrl>/media/...`) live under it.
   */
  publicUrl: string;
  /** Where data is kept: `sqliteStorage(...)` or `postgresStorage(...)` (or your own `Storage`). */
  storage: Storage;
  /** Directory for uploaded media files (default "./post-sync-media"). Must be shared if several servers run the worker. */
  mediaDir?: string;
  /** Upload size limit in MB (default 4096). */
  maxUploadMb?: number;
  /** App keys for each platform. */
  platforms?: PlatformKeys;
  /** Only offer these platforms (default: all). */
  enabledPlatforms?: PlatformId[];
  worker?: {
    /** Start the background worker in this process (default true). Set false to call `sync.worker.runDue()` yourself. */
    autoStart?: boolean;
    /** Jobs running at once in this process (default 3; always one per account). */
    concurrency?: number;
    /** Attempts for temporary errors (default 3). */
    maxAttempts?: number;
    pollIntervalMs?: number;
  };
  /** Your logger (default: console). Pass false to silence. */
  logger?: Logger | false;
  /** Overrides waiting inside publishers (tests). */
  sleep?: (ms: number) => Promise<void>;
}

/** Thrown by `connect.complete()`; carries where the browser should go back to. */
export class ConnectError extends Error {
  constructor(
    message: string,
    readonly returnTo: string | null,
    readonly connector: string,
  ) {
    super(message);
    this.name = "ConnectError";
  }
}

export interface MediaUpload {
  stream: Readable;
  filename: string;
  mimeType?: string;
}

/**
 * The publishing engine. One instance serves all your users: every call takes an `ownerId` (your user or workspace
 * id) and only sees that owner's accounts, media and posts.
 */
export class PostSync {
  readonly config: Config;
  readonly events: PostSyncEmitter;
  readonly enabled: Set<PlatformId>;
  /** @internal */ readonly secrets: Secrets;
  /** @internal */ readonly store: MediaStore;
  /** @internal */ readonly accountService: AccountService;
  /** @internal */ readonly postService: PostService;
  /** @internal */ readonly db: Storage;
  readonly logger: Logger;
  private readonly runner: Worker;

  constructor(options: PostSyncOptions) {
    if (!options.secret || options.secret.length < 32) throw new Error("PostSync: `secret` must be at least 32 characters.");
    let publicUrl: URL;
    try {
      publicUrl = new URL(options.publicUrl);
    } catch {
      throw new Error(`PostSync: \`publicUrl\` must be an absolute URL, got "${options.publicUrl}".`);
    }
    const mediaDir = path.resolve(options.mediaDir ?? "./post-sync-media");
    fs.mkdirSync(mediaDir, { recursive: true });
    this.config = {
      publicBaseUrl: publicUrl.toString().replace(/\/+$/, ""),
      mediaDir,
      maxUploadBytes: (options.maxUploadMb ?? 4096) * 1024 * 1024,
      workerConcurrency: Math.max(1, options.worker?.concurrency ?? 3),
      maxAttempts: Math.max(1, options.worker?.maxAttempts ?? 3),
      ...resolvePlatformKeys(options.platforms),
    };
    this.enabled = new Set(options.enabledPlatforms ?? (Object.keys(PLATFORMS) as PlatformId[]));
    this.logger = options.logger === false ? silentLogger : (options.logger ?? consoleLogger);
    this.events = new PostSyncEmitter((event, err) => this.logger.error(`listener for "${event}" failed`, err));
    this.db = options.storage;
    this.secrets = new Secrets(options.secret);
    this.store = new MediaStore(this.db, this.config, this.secrets);
    this.accountService = new AccountService(this.db, this.secrets, this.config, this.events);
    this.postService = new PostService(this.db, this.store, this.config, this.events, this.enabled);
    this.runner = new Worker({
      db: this.db,
      config: this.config,
      accounts: this.accountService,
      posts: this.postService,
      media: this.store,
      events: this.events,
      log: this.logger,
      sleep: options.sleep,
      pollIntervalMs: options.worker?.pollIntervalMs,
    });
  }

  // ---- events --------------------------------------------------------------------------------

  /** Subscribes to an event; returns an unsubscribe function. */
  on<E extends PostSyncEventName>(event: E, listener: (payload: PostSyncEvents[E]) => void): () => void {
    return this.events.on(event, listener);
  }

  // ---- description ---------------------------------------------------------------------------

  /** Platforms, their options and limits, and which ones are configured (for building your UI). */
  async describe(): Promise<Description> {
    const { config } = this;
    return {
      publicUrl: config.publicBaseUrl,
      publicMediaReachable: !isPrivateBaseUrl(config.publicBaseUrl),
      ffmpeg: await hasFfmpeg(),
      maxUploadMb: Math.round(config.maxUploadBytes / 1024 / 1024),
      supportedMimeTypes: SUPPORTED_MIME_TYPES,
      platforms: Object.values(PLATFORMS)
        .filter((p) => this.enabled.has(p.id))
        .map((p) => ({ id: p.id, name: p.name, connector: p.connector, capabilities: p.capabilities, options: p.options })),
      connectors: Object.values(CONNECTORS)
        .filter((c) => c.platforms.some((p) => this.enabled.has(p)))
        .map((c) => ({
          id: c.id,
          name: c.name,
          platforms: c.platforms.filter((p) => this.enabled.has(p)),
          kind: c.kind,
          configured: c.isConfigured(config),
          redirectUri: c.kind === "oauth" ? this.redirectUri(c.id) : null,
          developerPortal: c.developerPortal ?? null,
          credentialFields: c.credentialFields ?? null,
        })),
    };
  }

  /** The OAuth redirect URI to register in a platform's developer console. */
  redirectUri(connectorId: string): string {
    return `${this.config.publicBaseUrl}/oauth/${connectorId}/callback`;
  }

  // ---- accounts -------------------------------------------------------------------------------

  readonly accounts = {
    list: (ownerId: string): Promise<PublicAccount[]> => this.accountService.list(ownerId),

    get: async (ownerId: string, id: string): Promise<PublicAccount | null> => {
      const row = await this.db.getAccount(ownerId, id);
      return row ? this.accountService.toPublic(row) : null;
    },

    /** Disconnects an account. Returns "busy" while it has queued or running posts. */
    remove: async (ownerId: string, id: string): Promise<"deleted" | "not_found" | "busy"> => {
      if (!(await this.db.getAccount(ownerId, id))) return "not_found";
      if (await this.db.hasActiveTargetsForAccount(id)) return "busy";
      return (await this.accountService.remove(ownerId, id)) ? "deleted" : "not_found";
    },

    /** Checks that the saved login still works, without posting anything. */
    check: async (ownerId: string, id: string): Promise<CheckResult | null> => {
      const row = await this.db.getAccount(ownerId, id);
      const platform = row && getPlatform(row.platform);
      if (!row || !platform) return null;
      try {
        const detail = await platform.checkConnection({
          account: this.accountService.info(row),
          config: this.config,
          credentials: (opts) => this.accountService.credentials(row.id, opts),
        });
        await this.accountService.markActive(row);
        return { ok: true, detail };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof AuthError) await this.accountService.markNeedsReconnect(row, message);
        return { ok: false, error: message, needsReconnect: err instanceof AuthError };
      }
    },
  };

  // ---- connecting accounts --------------------------------------------------------------------

  readonly connect = {
    /**
     * Starts an OAuth login. Send the user's browser to the returned `url`; the platform sends them back to
     * `<publicUrl>/oauth/<connector>/callback`, and the handler then redirects to `returnTo`.
     * `returnTo` is trusted as given here: validate it if it comes from a browser (the HTTP handler does).
     */
    start: async (ownerId: string, connectorId: string, opts: { returnTo?: string | null } = {}): Promise<{ url: string }> => {
      const connector = getConnector(connectorId);
      if (!connector || connector.kind !== "oauth" || !connector.platforms.some((p) => this.enabled.has(p))) {
        throw new UserError(`Unknown connector "${connectorId}".`);
      }
      if (!connector.isConfigured(this.config)) throw new UserError(`${connector.name} isn't set up: its app keys are missing.`);
      const state = randomToken();
      const verifier = connector.usesPkce ? randomToken(48) : null;
      await this.db.saveOAuthState({
        state,
        owner_id: ownerId,
        connector: connector.id,
        code_verifier: verifier,
        return_to: opts.returnTo ?? null,
        created_at: Date.now(),
      });
      const url = connector.authorizeUrl!(this.config, {
        state,
        redirectUri: this.redirectUri(connector.id),
        codeChallenge: verifier ? pkceChallenge(verifier) : null,
      });
      return { url };
    },

    /**
     * Finishes an OAuth login from the callback's query parameters. Validated by the single-use `state` created in
     * `start()`, which also says which owner the accounts belong to.
     */
    complete: async (
      connectorId: string,
      query: Record<string, string | undefined>,
    ): Promise<{ ownerId: string; accounts: PublicAccount[]; returnTo: string | null; connector: string }> => {
      const connector = getConnector(connectorId);
      if (!connector || connector.kind !== "oauth") throw new ConnectError(`Unknown connector "${connectorId}".`, null, connectorId);
      const saved = query.state ? await this.db.takeOAuthState(query.state, Date.now() - 30 * 60_000) : undefined;
      if (!saved || saved.connector !== connector.id) {
        throw new ConnectError("That login link expired or was already used. Please try connecting again.", saved?.return_to ?? null, connector.name);
      }
      if (query.error || query.error_reason) {
        const reason = query.error_description || query.error_reason || query.error;
        throw new ConnectError(`${connector.name} login was cancelled or failed: ${reason}`, saved.return_to, connector.name);
      }
      if (!query.code) throw new ConnectError(`${connector.name} didn't return an authorization code.`, saved.return_to, connector.name);
      try {
        const drafts = await connector.exchangeCode!(this.config, {
          code: query.code,
          redirectUri: this.redirectUri(connector.id),
          codeVerifier: saved.code_verifier,
          query: Object.fromEntries(Object.entries(query).filter(([, v]) => typeof v === "string")) as Record<string, string>,
        });
        const accounts = await this.accountService.saveDrafts(
          saved.owner_id,
          connector.id,
          drafts.filter((d) => this.enabled.has(d.platform)),
        );
        return { ownerId: saved.owner_id, accounts, returnTo: saved.return_to, connector: connector.name };
      } catch (err) {
        this.logger.error(`connecting ${connector.name} failed`, err);
        const message = err instanceof Error ? err.message : String(err);
        throw new ConnectError(`Connecting ${connector.name} failed: ${message}`, saved.return_to, connector.name);
      }
    },

    /** Connects a platform that uses a form instead of OAuth (Bluesky: handle + app password). */
    withCredentials: async (ownerId: string, connectorId: string, fields: Record<string, string>): Promise<PublicAccount[]> => {
      const connector = getConnector(connectorId);
      if (!connector?.connectWithCredentials || !connector.platforms.some((p) => this.enabled.has(p))) {
        throw new UserError(`Unknown connector "${connectorId}".`);
      }
      const drafts = await connector.connectWithCredentials(this.config, fields ?? {});
      return this.accountService.saveDrafts(ownerId, connector.id as ConnectorId, drafts.filter((d) => this.enabled.has(d.platform)));
    },
  };

  // ---- media ------------------------------------------------------------------------------------

  readonly media = {
    upload: async (ownerId: string, file: MediaUpload): Promise<PublicMedia> =>
      this.store.toPublic(await this.store.save(ownerId, file.stream, file.filename, file.mimeType ?? "")),
    fromFile: async (ownerId: string, filePath: string, opts?: { filename?: string; mimeType?: string }): Promise<PublicMedia> =>
      this.store.toPublic(await this.store.fromFile(ownerId, filePath, opts)),
    fromBuffer: async (ownerId: string, data: Uint8Array, filename: string, mimeType?: string): Promise<PublicMedia> =>
      this.store.toPublic(await this.store.fromBuffer(ownerId, data, filename, mimeType)),
    /**
     * Downloads a file into the media store. This makes your server fetch the URL: only pass URLs you trust, and pass
     * `allow` to restrict where it (and any redirect) may point.
     */
    fromUrl: async (ownerId: string, url: string, opts?: { filename?: string; allow?: (url: URL) => boolean }): Promise<PublicMedia> =>
      this.store.toPublic(await this.store.fromUrl(ownerId, url, opts)),
    get: async (ownerId: string, id: string): Promise<PublicMedia | null> => {
      const row = await this.db.getMedia(ownerId, id);
      return row ? this.store.toPublic(row) : null;
    },
    /** Deletes an upload. Returns "in_use" if a post uses it. */
    remove: async (ownerId: string, id: string): Promise<"deleted" | "not_found" | "in_use"> => {
      const row = await this.db.getMedia(ownerId, id);
      if (!row) return "not_found";
      if (await this.db.isMediaReferenced(id)) return "in_use";
      await this.store.remove(row);
      return "deleted";
    },
  };

  // ---- posts --------------------------------------------------------------------------------------

  readonly posts = {
    /** Checks a post against every selected account's rules without creating it. */
    validate: (ownerId: string, req: PostRequest): Promise<TargetIssue[]> => this.postService.validate(ownerId, parsePostRequest(req)),
    /** Creates the post and queues one publish job per account (now, or at `scheduledAt`). */
    create: async (ownerId: string, req: PostRequest): Promise<PublicPost> => {
      const post = await this.postService.create(ownerId, parsePostRequest(req));
      this.runner.kick();
      return post;
    },
    list: (ownerId: string, opts?: { limit?: number; before?: number }): Promise<PostPage> => this.postService.list(ownerId, opts),
    get: (ownerId: string, id: string): Promise<PublicPost | null> => this.postService.get(ownerId, id),
    /** Removes a post from the history (published posts stay online). */
    remove: (ownerId: string, id: string) => this.postService.remove(ownerId, id),
  };

  readonly targets = {
    /** Queues a failed or cancelled publish job again. */
    retry: async (ownerId: string, id: string): Promise<boolean> => {
      const ok = await this.db.retryTarget(ownerId, id);
      if (ok) this.runner.kick();
      return ok;
    },
    /** Cancels a queued (e.g. scheduled) publish job. */
    cancel: async (ownerId: string, id: string): Promise<boolean> => {
      const ok = await this.db.cancelTarget(ownerId, id);
      if (ok) {
        const t = await this.db.getTarget(ownerId, id);
        if (t) this.events.emit("target.cancelled", { target: this.postService.targetToPublic(t) });
      }
      return ok;
    },
  };

  // ---- worker -------------------------------------------------------------------------------------

  readonly worker = {
    start: () => this.runner.start(),
    stop: (timeoutMs?: number) => this.runner.stop(timeoutMs),
    /** Runs all due jobs now and waits for them (for cron/serverless setups with `worker.autoStart: false`). */
    runDue: () => this.runner.runDue(),
    /** Waits until jobs running in this process are done. */
    idle: () => this.runner.idle(),
    isRunning: () => this.runner.isRunning,
  };

  /** Stops the worker and closes the storage. */
  async close(): Promise<void> {
    await this.runner.stop(10_000);
    await this.db.close();
  }
}

/**
 * Creates the engine, prepares the database tables and (unless `worker.autoStart` is false) starts publishing.
 *
 * ```ts
 * const sync = await createPostSync({
 *   secret: process.env.POST_SYNC_SECRET!,
 *   publicUrl: "https://api.example.com/social",
 *   storage: sqliteStorage("./data/post-sync.db"),
 *   platforms: { meta: { appId, appSecret } },
 * });
 * ```
 */
export async function createPostSync(options: PostSyncOptions): Promise<PostSync> {
  const sync = new PostSync(options);
  await options.storage.migrate();
  if (options.worker?.autoStart !== false) sync.worker.start();
  return sync;
}
