import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface Config {
  port: number;
  host: string;
  /** Public URL of this server. Used for OAuth redirect URIs and for media URLs that platforms download. */
  publicBaseUrl: string;
  dataDir: string;
  mediaDir: string;
  appSecret: string;
  adminPassword: string;
  /** Optional token for programmatic access: `Authorization: Bearer <API_TOKEN>`. */
  apiToken: string | null;
  maxUploadBytes: number;
  workerConcurrency: number;
  maxAttempts: number;
  meta: { appId: string; appSecret: string; graphVersion: string; loginConfigId: string | null; extraScopes: string[] };
  threads: { appId: string; appSecret: string };
  tiktok: { clientKey: string; clientSecret: string; scopes: string };
  linkedin: { clientId: string; clientSecret: string; version: string | null; organizations: boolean };
  google: { clientId: string; clientSecret: string };
  x: { clientId: string; clientSecret: string };
}

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

function envBool(name: string, fallback = false): boolean {
  const raw = env(name).toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

/** Loads `.env` from the working directory if present (without overriding real env vars). */
export function loadDotEnv(file = path.resolve(process.cwd(), ".env")): void {
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

/**
 * APP_SECRET encrypts stored platform tokens and signs cookies/media URLs. If it isn't set we generate
 * one once and keep it in the data dir, so a fresh install works without extra setup.
 */
function resolveAppSecret(dataDir: string): string {
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

export function loadConfig(): Config {
  const port = envInt("PORT", 3000);
  const publicBaseUrl = env("PUBLIC_BASE_URL", `http://localhost:${port}`).replace(/\/+$/, "");
  try {
    new URL(publicBaseUrl);
  } catch {
    throw new Error(`PUBLIC_BASE_URL is not a valid URL: "${publicBaseUrl}"`);
  }

  const dataDir = path.resolve(env("DATA_DIR", "./data"));
  const mediaDir = path.join(dataDir, "media");
  fs.mkdirSync(mediaDir, { recursive: true });

  const adminPassword = env("ADMIN_PASSWORD");
  if (!adminPassword) {
    throw new Error(
      "ADMIN_PASSWORD is not set. Copy .env.example to .env and choose a password for the dashboard.",
    );
  }

  return {
    port,
    host: env("HOST", "0.0.0.0"),
    publicBaseUrl,
    dataDir,
    mediaDir,
    appSecret: resolveAppSecret(dataDir),
    adminPassword,
    apiToken: env("API_TOKEN") || null,
    maxUploadBytes: envInt("MAX_UPLOAD_MB", 4096) * 1024 * 1024,
    workerConcurrency: Math.max(1, envInt("WORKER_CONCURRENCY", 3)),
    maxAttempts: Math.max(1, envInt("MAX_ATTEMPTS", 3)),
    meta: {
      appId: env("META_APP_ID"),
      appSecret: env("META_APP_SECRET"),
      graphVersion: env("META_GRAPH_VERSION", "v26.0"),
      loginConfigId: env("META_LOGIN_CONFIG_ID") || null,
      // e.g. "ads_read": Meta requires it to publish to Instagram when your Page role comes from Business Manager.
      extraScopes: env("META_EXTRA_SCOPES")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    },
    threads: { appId: env("THREADS_APP_ID"), appSecret: env("THREADS_APP_SECRET") },
    tiktok: {
      clientKey: env("TIKTOK_CLIENT_KEY"),
      clientSecret: env("TIKTOK_CLIENT_SECRET"),
      scopes: env("TIKTOK_SCOPES", "user.info.basic,video.publish,video.upload"),
    },
    linkedin: {
      clientId: env("LINKEDIN_CLIENT_ID"),
      clientSecret: env("LINKEDIN_CLIENT_SECRET"),
      version: env("LINKEDIN_VERSION") || null,
      organizations: envBool("LINKEDIN_ORGANIZATIONS"),
    },
    google: { clientId: env("GOOGLE_CLIENT_ID"), clientSecret: env("GOOGLE_CLIENT_SECRET") },
    x: { clientId: env("X_CLIENT_ID"), clientSecret: env("X_CLIENT_SECRET") },
  };
}

/** True when the host is obviously not reachable from the public internet (platform servers can't download from it). */
export function isPrivateBaseUrl(baseUrl: string): boolean {
  const host = new URL(baseUrl).hostname;
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host === "[::1]" || host === "::1") return true;
  const m = host.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 0;
}
