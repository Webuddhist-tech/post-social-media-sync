import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { ConnectorId, PlatformKeys, PostSyncEventName } from "post-social-media-sync";
import { EVENT_NAMES } from "./webhooks.js";

export interface DashboardConfig {
  port: number;
  host: string;
  /** Public URL of this server, without a trailing slash. The API (and OAuth callbacks) live under `<siteUrl>/api`. */
  siteUrl: string;
  /**
   * Which X-Forwarded-For hops to believe for the client address (login rate limit): false = none (default), true = all,
   * the number of proxies in front of the server (only if it can't be reached directly), or the proxies' addresses/CIDR ranges.
   */
  trustProxy: boolean | number | string[];
  dataDir: string;
  secret: string;
  /** Serve the web dashboard (password login). false = headless: only the HTTP API, for your own backend/frontend. */
  dashboard: boolean;
  adminPassword: string | null;
  /** Bearer token for backends and scripts. Requests may act for any user with an `X-Owner-Id` header. */
  apiToken: string | null;
  /** Run publish jobs in this process. Turn off on extra API-only replicas (needs DATABASE_URL). */
  runWorker: boolean;
  /** PostgreSQL connection string. Default: SQLite in DATA_DIR. */
  databaseUrl: string | null;
  maxUploadMb: number;
  workerConcurrency: number;
  maxAttempts: number;
  platforms: PlatformKeys;
  webhook: { url: string; secret: string | null; events: PostSyncEventName[] | null } | null;
  /** Origins (besides siteUrl) that `returnTo` may send browsers back to after connecting an account. */
  allowedReturnOrigins: string[];
  /** Frontends on other origins allowed to call the API from the browser. */
  corsOrigins: string[];
  /** Hosts POST /api/media/from-url may download from (e.g. your bucket). Empty = disabled. */
  remoteMediaHosts: string[];
}

/** Env vars that enable each connector (shown in the dashboard's setup page). */
export const CONNECTOR_ENV: Record<ConnectorId, string[]> = {
  meta: ["META_APP_ID", "META_APP_SECRET"],
  threads: ["THREADS_APP_ID", "THREADS_APP_SECRET"],
  tiktok: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"],
  linkedin: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"],
  google: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  x: ["X_CLIENT_ID", "X_CLIENT_SECRET"],
  bluesky: [],
};

function env(name: string, fallback = ""): string {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? fallback : value.trim();
}

function envInt(name: string, fallback: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = env(name).toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} must be on or off, got "${raw}"`);
}

function envList(name: string): string[] {
  return env(name)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function origins(name: string): string[] {
  return envList(name).map((o) => {
    try {
      return new URL(o).origin;
    } catch {
      throw new Error(`${name} must be a comma-separated list of URLs, got "${o}"`);
    }
  });
}

const PROXY_PRESETS = ["loopback", "linklocal", "uniquelocal"];

/** An IP address, a CIDR range (or address/netmask), or one of proxy-addr's presets. */
function isProxyAddress(entry: string): boolean {
  if (PROXY_PRESETS.includes(entry)) return true;
  const [ip, range, ...rest] = entry.split("/");
  const version = net.isIP(ip);
  if (!version || rest.length) return false;
  if (range === undefined) return true;
  if (/^\d{1,3}$/.test(range)) return Number(range) <= (version === 4 ? 32 : 128);
  return version === 4 && net.isIPv4(range);
}

/**
 * TRUST_PROXY: off by default, so a client connecting directly can't pick its own address with X-Forwarded-For.
 * Behind a reverse proxy set it to the proxies' addresses (e.g. loopback, uniquelocal, 10.0.0.0/8), or to their number
 * (usually 1) when the server is only reachable through them.
 */
function trustProxy(): boolean | number | string[] {
  const raw = env("TRUST_PROXY");
  const lower = raw.toLowerCase();
  if (!raw || ["false", "off", "no"].includes(lower)) return false;
  if (["true", "on", "yes"].includes(lower)) return true;
  if (/^\d+$/.test(raw)) return Number(raw) || false;
  const entries = envList("TRUST_PROXY");
  for (const entry of entries) {
    if (!isProxyAddress(entry)) {
      throw new Error(
        `TRUST_PROXY must be off, on, a number of proxies or a comma-separated list of IP addresses/CIDR ranges, got "${entry}"`,
      );
    }
  }
  return entries;
}

/** Loads `.env` from the working directory if present (without overriding real env vars). */
export function loadDotEnv(file = path.resolve(process.cwd(), ".env")): void {
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

/**
 * APP_SECRET encrypts stored platform tokens and signs cookies and media URLs. If it isn't set we generate one once
 * and keep it in the data dir, so a fresh install works without extra setup.
 */
function resolveSecret(dataDir: string): string {
  const fromEnv = env("APP_SECRET");
  if (fromEnv) {
    if (fromEnv.length < 32) throw new Error("APP_SECRET must be at least 32 characters long");
    return fromEnv;
  }
  const file = path.join(dataDir, ".app-secret");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  const secret = crypto.randomBytes(48).toString("base64url");
  fs.writeFileSync(file, secret + "\n", { mode: 0o600 });
  return secret;
}

export function loadConfig(): DashboardConfig {
  const port = envInt("PORT", 3000);
  const siteUrl = env("PUBLIC_BASE_URL", `http://localhost:${port}`).replace(/\/+$/, "");
  try {
    new URL(siteUrl);
  } catch {
    throw new Error(`PUBLIC_BASE_URL is not a valid URL: "${siteUrl}"`);
  }

  const dataDir = path.resolve(env("DATA_DIR", "./data"));
  fs.mkdirSync(dataDir, { recursive: true });

  const dashboard = envBool("DASHBOARD", true);
  const adminPassword = env("ADMIN_PASSWORD") || null;
  const apiToken = env("API_TOKEN") || null;
  if (dashboard && !adminPassword) {
    throw new Error(
      "ADMIN_PASSWORD is not set. Copy .env.example to .env and choose a password for the dashboard (or set DASHBOARD=off and API_TOKEN for API-only use).",
    );
  }
  if (!dashboard && !apiToken) throw new Error("DASHBOARD=off needs API_TOKEN: without it nobody could use the API.");
  if (apiToken && apiToken.length < 16) throw new Error("API_TOKEN must be at least 16 characters long.");

  const databaseUrl = env("DATABASE_URL") || null;
  const runWorker = envBool("WORKER", true);
  if (!runWorker && !databaseUrl) {
    throw new Error("WORKER=off only makes sense with DATABASE_URL (another process must publish from the same database).");
  }

  const webhookUrl = env("WEBHOOK_URL");
  if (webhookUrl) {
    try {
      new URL(webhookUrl);
    } catch {
      throw new Error(`WEBHOOK_URL is not a valid URL: "${webhookUrl}"`);
    }
  }
  const webhookEvents = envList("WEBHOOK_EVENTS") as PostSyncEventName[];
  const unknownEvents = webhookEvents.filter((e) => !EVENT_NAMES.includes(e));
  if (unknownEvents.length) {
    throw new Error(`WEBHOOK_EVENTS has unknown events: ${unknownEvents.join(", ")}. Valid events: ${EVENT_NAMES.join(", ")}`);
  }

  return {
    port,
    host: env("HOST", "0.0.0.0"),
    siteUrl,
    trustProxy: trustProxy(),
    dataDir,
    secret: resolveSecret(dataDir),
    dashboard,
    adminPassword,
    apiToken,
    runWorker,
    databaseUrl,
    maxUploadMb: envInt("MAX_UPLOAD_MB", 4096),
    workerConcurrency: Math.max(1, envInt("WORKER_CONCURRENCY", 3)),
    maxAttempts: Math.max(1, envInt("MAX_ATTEMPTS", 3)),
    webhook: webhookUrl ? { url: webhookUrl, secret: env("WEBHOOK_SECRET") || null, events: webhookEvents.length ? webhookEvents : null } : null,
    allowedReturnOrigins: origins("ALLOWED_RETURN_ORIGINS"),
    corsOrigins: origins("CORS_ORIGINS"),
    remoteMediaHosts: envList("REMOTE_MEDIA_HOSTS").map((h) => h.toLowerCase()),
    platforms: {
      meta: {
        appId: env("META_APP_ID"),
        appSecret: env("META_APP_SECRET"),
        graphVersion: env("META_GRAPH_VERSION") || undefined,
        loginConfigId: env("META_LOGIN_CONFIG_ID") || null,
        // e.g. "ads_read": Meta requires it to publish to Instagram when your Page role comes from Business Manager.
        extraScopes: envList("META_EXTRA_SCOPES"),
      },
      threads: { appId: env("THREADS_APP_ID"), appSecret: env("THREADS_APP_SECRET") },
      tiktok: { clientKey: env("TIKTOK_CLIENT_KEY"), clientSecret: env("TIKTOK_CLIENT_SECRET"), scopes: env("TIKTOK_SCOPES") || undefined },
      linkedin: {
        clientId: env("LINKEDIN_CLIENT_ID"),
        clientSecret: env("LINKEDIN_CLIENT_SECRET"),
        version: env("LINKEDIN_VERSION") || null,
        organizations: envBool("LINKEDIN_ORGANIZATIONS", false),
      },
      google: { clientId: env("GOOGLE_CLIENT_ID"), clientSecret: env("GOOGLE_CLIENT_SECRET") },
      x: { clientId: env("X_CLIENT_ID"), clientSecret: env("X_CLIENT_SECRET") },
      // Servers users may sign in to Bluesky through (default: https://bsky.social only).
      bluesky: envList("BLUESKY_SERVERS").length ? { servers: origins("BLUESKY_SERVERS") } : undefined,
    },
  };
}
