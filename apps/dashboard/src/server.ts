import path from "node:path";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { createPostSync, type Logger, type PostSync, type Storage } from "post-social-media-sync";
import { postSyncFastify } from "post-social-media-sync/fastify";
import { postgresStorage } from "post-social-media-sync/postgres";
import { sqliteStorage } from "post-social-media-sync/sqlite";
import { Auth } from "./auth.js";
import { CONNECTOR_ENV, type DashboardConfig } from "./config.js";
import { forwardEvents } from "./webhooks.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.resolve(here, "..", "public");

export interface BuildOptions {
  config: DashboardConfig;
  logger?: FastifyServerOptions["logger"];
  /** Storage override (tests). Default: DATABASE_URL (PostgreSQL) or SQLite in DATA_DIR. */
  storage?: Storage;
  /** Overrides waiting in publishers and webhook retries (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Start the publish worker (default: config.runWorker). */
  startWorker?: boolean;
}

declare module "fastify" {
  interface FastifyInstance {
    postSync: PostSync;
  }
}

/**
 * Fastify ignores a bare hop count (it can't tell a proxy from a client that connects directly), so TRUST_PROXY=<n>
 * trusts the n nearest hops explicitly: only safe when the server can't be reached except through those proxies.
 */
function trustProxyOption(trust: DashboardConfig["trustProxy"]): FastifyServerOptions["trustProxy"] {
  return typeof trust === "number" ? (_address: string, hop: number) => hop < trust : trust;
}

/** The ready-to-run server: the Post Sync API under /api, plus (unless DASHBOARD=off) the web dashboard. */
export async function buildServer(opts: BuildOptions): Promise<FastifyInstance> {
  const { config } = opts;
  // trustProxy decides whose X-Forwarded-For counts as req.ip (the login rate limit's key): off unless TRUST_PROXY says so.
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: trustProxyOption(config.trustProxy), bodyLimit: 64 * 1024 });

  const logger: Logger = {
    info: (m, ...e) => app.log.info(e.length ? { extra: e } : {}, m),
    warn: (m, ...e) => app.log.warn(e.length ? { extra: e } : {}, m),
    error: (m, ...e) => app.log.error(e[0] instanceof Error ? { err: e[0] } : e.length ? { extra: e } : {}, m),
  };
  const storage =
    opts.storage ?? (config.databaseUrl ? postgresStorage(config.databaseUrl) : sqliteStorage(path.join(config.dataDir, "post-sync.db")));
  const sync = await createPostSync({
    secret: config.secret,
    publicUrl: `${config.siteUrl}/api`,
    storage,
    mediaDir: path.join(config.dataDir, "media"),
    maxUploadMb: config.maxUploadMb,
    platforms: config.platforms,
    worker: { autoStart: false, concurrency: config.workerConcurrency, maxAttempts: config.maxAttempts },
    logger,
    sleep: opts.sleep,
  });
  app.decorate("postSync", sync);
  if (config.webhook) forwardEvents(sync, { ...config.webhook, log: logger, sleep: opts.sleep });

  const auth = new Auth(config);
  await app.register(cookie);

  // Security headers for every response, the API's included.
  app.addHook("onRequest", async (_req, reply) => {
    reply.raw.setHeader("X-Content-Type-Options", "nosniff");
    reply.raw.setHeader("X-Frame-Options", "DENY");
    reply.raw.setHeader("Referrer-Policy", "same-origin");
  });

  // Set before the routes: each route keeps the error handler that was in place when it was registered.
  app.setErrorHandler((err: any, req, reply) => {
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    req.log.error(err);
    return reply.code(500).send({ error: "Internal server error" });
  });

  app.get("/healthz", async () => ({ ok: true }));

  if (config.dashboard) {
    await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: "/", index: ["index.html"], wildcard: false });

    let warnedProxy = false;
    app.post<{ Body: { password?: string } }>("/api/login", async (req, reply) => {
      if (config.trustProxy === false && req.headers["x-forwarded-for"] && !warnedProxy) {
        warnedProxy = true;
        req.log.warn(
          "Login requests carry X-Forwarded-For but TRUST_PROXY is off: behind a reverse proxy, set TRUST_PROXY to its address (e.g. loopback or uniquelocal) so the login rate limit sees client addresses.",
        );
      }
      const result = auth.login(String(req.body?.password ?? ""), req.ip);
      if (!result.ok) {
        if (result.retryAfterSec) {
          reply.header("Retry-After", String(result.retryAfterSec));
          return reply.code(429).send({ error: `Too many attempts. Try again in ${Math.ceil(result.retryAfterSec / 60)} min.` });
        }
        return reply.code(401).send({ error: "Wrong password." });
      }
      auth.setCookie(reply, result.cookie);
      return { ok: true };
    });

    app.post("/api/logout", async (req, reply) => {
      // Session cookies can't be revoked one by one: logging out ends every session (other browsers too).
      if (auth.hasSession(req)) auth.logoutEverywhere();
      auth.clearCookie(reply);
      return { ok: true };
    });

    app.get("/api/session", async (req) => ({ authenticated: auth.hasSession(req) }));
  }

  // Everything the dashboard's setup page needs: the engine's description plus which .env keys enable what.
  app.get("/api/meta", async (req, reply) => {
    if (!auth.ownerId(req)) return reply.code(401).send({ error: "Not logged in." });
    const description = await sync.describe();
    return {
      ...description,
      publicBaseUrl: config.siteUrl,
      connectors: description.connectors.map((c) => ({ ...c, envVars: CONNECTOR_ENV[c.id] ?? [] })),
    };
  });

  // The Post Sync HTTP API (accounts, OAuth, media, posts) for this dashboard and for your own frontend/backend.
  await app.register(postSyncFastify, {
    prefix: "/api",
    sync,
    authenticate: (req) => auth.ownerId(req),
    allowedRedirectOrigins: [new URL(config.siteUrl).origin, ...config.allowedReturnOrigins],
    defaultReturnTo: `${config.siteUrl}/#accounts`,
    cors: config.corsOrigins.length ? { origins: config.corsOrigins, credentials: true } : undefined,
    allowRemoteMedia: config.remoteMediaHosts.length ? (url) => config.remoteMediaHosts.includes(url.hostname.toLowerCase()) : undefined,
  });

  app.addHook("onClose", async () => sync.close());
  if (opts.startWorker ?? config.runWorker) app.addHook("onReady", async () => sync.worker.start());
  return app;
}
