import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { createPostSync, UserError, type Logger, type PlatformKeys, type PostSync, type Storage } from "post-social-media-sync";
import { postSyncExpress } from "post-social-media-sync/express";
import { sqliteStorage } from "post-social-media-sync/sqlite";

const here = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.resolve(here, "..", "public");

export interface AppOptions {
  /** Public URL of this server without a trailing slash, e.g. "https://myapp.example.com". */
  baseUrl: string;
  /** 32+ characters. Encrypts saved platform logins, signs media URLs and (here) the demo session cookie. */
  secret: string;
  /** Uploaded media and, unless `storage` is given, the SQLite database live here. */
  dataDir: string;
  /** Default: SQLite at <dataDir>/post-sync.db. Use postgresStorage(...) from "post-social-media-sync/postgres" in production. */
  storage?: Storage;
  /** App keys per platform. Bluesky needs none. */
  platforms?: PlatformKeys;
  /** Default: console. false = quiet. */
  logger?: Logger | false;
  /** Publish in this process (default true). Tests turn it off and call `sync.worker.runDue()`. */
  startWorker?: boolean;
}

export interface HostApp {
  app: express.Express;
  sync: PostSync;
  /** Stops the publish worker (letting running uploads finish) and closes the database. */
  close(): Promise<void>;
}

// ---- DEMO AUTH: replace with your real session / auth middleware ------------------------------------------------
// "Logging in" just picks a user name, kept in an HMAC-signed cookie. There are no passwords: it only exists to show
// that every user of your app gets their own accounts, media and posts. Never ship this.

const SESSION_COOKIE = "demo_user";
const USER_NAME = /^[a-z0-9_-]{1,32}$/;

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function demoAuth(secret: string, secure: boolean) {
  const sign = (user: string) => crypto.createHmac("sha256", secret).update(`demo-user:${user}`).digest("base64url");
  return {
    /** The logged-in user's id, or null. This is what the Post Sync handler calls `ownerId`. */
    currentUser(req: Request): string | null {
      const [user, sig] = (readCookie(req, SESSION_COOKIE) ?? "").split(".");
      if (!user || !sig || !USER_NAME.test(user)) return null;
      const expected = Buffer.from(sign(user));
      const given = Buffer.from(sig);
      return given.length === expected.length && crypto.timingSafeEqual(given, expected) ? user : null;
    },
    login(res: Response, user: string): void {
      res.cookie(SESSION_COOKIE, `${user}.${sign(user)}`, { httpOnly: true, sameSite: "lax", secure, path: "/" });
    },
    logout(res: Response): void {
      res.clearCookie(SESSION_COOKIE, { path: "/" });
    },
  };
}

// ---- your app's own data ----------------------------------------------------------------------------------------

const ARTICLES = [
  { slug: "launch", title: "We just launched our new website", path: "/blog/launch" },
  { slug: "changelog-12", title: "What's new in version 1.2", path: "/blog/changelog-12" },
];

/** An existing Express backend that adds multi-platform posting under /social, with its own frontend in public/. */
export async function createApp(options: AppOptions): Promise<HostApp> {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const log: Logger = options.logger === false ? { info() {}, warn() {}, error() {} } : (options.logger ?? console);

  const sync = await createPostSync({
    secret: options.secret,
    // Where the handler is mounted below. OAuth redirect URIs are <baseUrl>/social/oauth/<connector>/callback.
    publicUrl: `${baseUrl}/social`,
    storage: options.storage ?? sqliteStorage(path.join(options.dataDir, "post-sync.db")),
    mediaDir: path.join(options.dataDir, "media"),
    platforms: options.platforms,
    logger: log,
    worker: { autoStart: options.startWorker ?? true },
  });

  // React to publishing results, e.g. notify the user or update your own records.
  sync.on("target.succeeded", ({ target }) => {
    log.info(`[${target.ownerId}] published to ${target.platform} (${target.accountName}): ${target.remoteUrl ?? target.remoteId ?? "ok"}`);
  });
  sync.on("target.failed", ({ target, error, willRetry }) => {
    log.warn(`[${target.ownerId}] ${target.platform} (${target.accountName}) failed${willRetry ? ", will retry" : ""}: ${error}`);
  });
  sync.on("account.needsReconnect", ({ account, message }) => {
    log.warn(`[${account.ownerId}] ${account.platform} account ${account.name} must be reconnected: ${message}`);
  });

  const auth = demoAuth(options.secret, baseUrl.startsWith("https://"));
  const app = express();
  app.disable("x-powered-by");
  // Your existing middleware stays as it is: the Post Sync middleware works before or after express.json().
  app.use(express.json());

  app.post("/login", (req, res) => {
    const user = String(req.body?.name ?? "").trim().toLowerCase();
    if (!USER_NAME.test(user)) {
      res.status(400).json({ error: "Pick a user name: 1-32 letters, digits, - or _." });
      return;
    }
    auth.login(res, user);
    res.json({ user });
  });
  app.post("/logout", (_req, res) => {
    auth.logout(res);
    res.json({ ok: true });
  });
  app.get("/me", (req, res) => {
    res.json({ user: auth.currentUser(req) });
  });

  // The Post Sync HTTP API for your frontend: accounts, OAuth, uploads, posts. Each user only sees their own data.
  app.use("/social", postSyncExpress(sync, { authenticate: (req) => auth.currentUser(req) }));

  // A route of your own that publishes programmatically (no HTTP round trip through /social).
  app.get("/api/articles", (_req, res) => {
    res.json({ articles: ARTICLES.map((a) => ({ ...a, url: baseUrl + a.path })) });
  });
  app.post("/api/articles/:slug/share", async (req, res) => {
    const user = auth.currentUser(req);
    if (!user) {
      res.status(401).json({ error: "Log in first." });
      return;
    }
    const article = ARTICLES.find((a) => a.slug === req.params.slug);
    if (!article) {
      res.status(404).json({ error: "No such article." });
      return;
    }
    const accounts = (await sync.accounts.list(user)).filter((a) => a.status === "active");
    if (!accounts.length) {
      res.status(400).json({ error: "Connect an account first." });
      return;
    }
    try {
      const post = await sync.posts.create(user, {
        text: `${article.title}\n\n${baseUrl}${article.path}`,
        targets: accounts.map((a) => ({ accountId: a.id })),
      });
      res.status(201).json({ post });
    } catch (err) {
      // UserError: something the user must fix, e.g. the post breaks a platform's rules (`issues` lists them per account).
      if (err instanceof UserError) {
        res.status(400).json({ error: err.message, issues: (err as UserError & { issues?: unknown }).issues });
        return;
      }
      throw err;
    }
  });

  app.use(express.static(PUBLIC_DIR));

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    // 4xx from middleware (e.g. malformed JSON for express.json()) keep their status.
    const status = (err as { status?: unknown })?.status;
    if (typeof status === "number" && status >= 400 && status < 500) {
      res.status(status).json({ error: (err as Error).message });
      return;
    }
    log.error(`${req.method} ${req.path} failed`, err);
    res.status(500).json({ error: "Internal server error" });
  });

  return { app, sync, close: () => sync.close() };
}
