import fs from "node:fs";
import path from "node:path";
import { sqliteStorage } from "post-social-media-sync/sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONNECTOR_ENV, loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { mockFetch, removeTempDirs, tempDir } from "./helpers.js";

const VARS = [
  "PORT",
  "HOST",
  "PUBLIC_BASE_URL",
  "DATA_DIR",
  "APP_SECRET",
  "DASHBOARD",
  "ADMIN_PASSWORD",
  "API_TOKEN",
  "WORKER",
  "DATABASE_URL",
  "MAX_UPLOAD_MB",
  "WORKER_CONCURRENCY",
  "MAX_ATTEMPTS",
  "WEBHOOK_URL",
  "WEBHOOK_SECRET",
  "WEBHOOK_EVENTS",
  "ALLOWED_RETURN_ORIGINS",
  "CORS_ORIGINS",
  "REMOTE_MEDIA_HOSTS",
  "META_APP_ID",
  "META_APP_SECRET",
  "META_GRAPH_VERSION",
  "META_LOGIN_CONFIG_ID",
  "META_EXTRA_SCOPES",
  "THREADS_APP_ID",
  "THREADS_APP_SECRET",
  "TIKTOK_CLIENT_KEY",
  "TIKTOK_CLIENT_SECRET",
  "TIKTOK_SCOPES",
  "LINKEDIN_CLIENT_ID",
  "LINKEDIN_CLIENT_SECRET",
  "LINKEDIN_ORGANIZATIONS",
  "LINKEDIN_VERSION",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "X_CLIENT_ID",
  "X_CLIENT_SECRET",
];

const SECRET = "s".repeat(40);
let dataDir: string;

/** Starts from a clean environment with only the minimum a dashboard needs, then applies `vars`. */
function env(vars: Record<string, string>) {
  for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v);
}

beforeEach(() => {
  for (const name of VARS) vi.stubEnv(name, undefined);
  dataDir = tempDir();
  env({ DATA_DIR: dataDir, ADMIN_PASSWORD: "hunter22", APP_SECRET: SECRET });
});
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(removeTempDirs);

describe("loadConfig", () => {
  it("has working defaults", () => {
    const config = loadConfig();
    expect(config).toMatchObject({
      port: 3000,
      host: "0.0.0.0",
      siteUrl: "http://localhost:3000",
      dataDir,
      secret: SECRET,
      dashboard: true,
      adminPassword: "hunter22",
      apiToken: null,
      runWorker: true,
      databaseUrl: null,
      maxUploadMb: 4096,
      workerConcurrency: 3,
      maxAttempts: 3,
      webhook: null,
      allowedReturnOrigins: [],
      corsOrigins: [],
      remoteMediaHosts: [],
    });
    expect(config.platforms.meta).toMatchObject({ appId: "", appSecret: "", loginConfigId: null, extraScopes: [] });
    expect(config.platforms.linkedin).toMatchObject({ organizations: false, version: null });
  });

  it("reads every setting", () => {
    env({
      PORT: "8080",
      HOST: "127.0.0.1",
      PUBLIC_BASE_URL: "https://posts.example.com/",
      DASHBOARD: "off",
      API_TOKEN: "api-token-0123456789",
      WORKER: "off",
      DATABASE_URL: "postgres://u:p@db/postsync",
      MAX_UPLOAD_MB: "100",
      WORKER_CONCURRENCY: "0",
      MAX_ATTEMPTS: "5",
      WEBHOOK_URL: "https://hooks.example.com/in",
      WEBHOOK_SECRET: "whsec",
      WEBHOOK_EVENTS: "target.failed, account.needsReconnect",
      ALLOWED_RETURN_ORIGINS: "https://app.example.com/settings, http://localhost:5173",
      CORS_ORIGINS: "https://app.example.com",
      REMOTE_MEDIA_HOSTS: "Bucket.Example.com, cdn.example.com",
      META_APP_ID: "meta-id",
      META_APP_SECRET: "meta-secret",
      META_GRAPH_VERSION: "v27.0",
      META_LOGIN_CONFIG_ID: "cfg-1",
      META_EXTRA_SCOPES: "ads_read, business_management",
      THREADS_APP_ID: "th-id",
      THREADS_APP_SECRET: "th-secret",
      TIKTOK_CLIENT_KEY: "tt-key",
      TIKTOK_CLIENT_SECRET: "tt-secret",
      TIKTOK_SCOPES: "user.info.basic,video.upload",
      LINKEDIN_CLIENT_ID: "li-id",
      LINKEDIN_CLIENT_SECRET: "li-secret",
      LINKEDIN_ORGANIZATIONS: "yes",
      LINKEDIN_VERSION: "202601",
      GOOGLE_CLIENT_ID: "g-id",
      GOOGLE_CLIENT_SECRET: "g-secret",
      X_CLIENT_ID: "x-id",
      X_CLIENT_SECRET: "x-secret",
    });
    const config = loadConfig();
    expect(config).toMatchObject({
      port: 8080,
      host: "127.0.0.1",
      siteUrl: "https://posts.example.com",
      dashboard: false,
      apiToken: "api-token-0123456789",
      runWorker: false,
      databaseUrl: "postgres://u:p@db/postsync",
      maxUploadMb: 100,
      workerConcurrency: 1,
      maxAttempts: 5,
      webhook: { url: "https://hooks.example.com/in", secret: "whsec", events: ["target.failed", "account.needsReconnect"] },
      allowedReturnOrigins: ["https://app.example.com", "http://localhost:5173"],
      corsOrigins: ["https://app.example.com"],
      remoteMediaHosts: ["bucket.example.com", "cdn.example.com"],
    });
    expect(config.platforms).toEqual({
      meta: { appId: "meta-id", appSecret: "meta-secret", graphVersion: "v27.0", loginConfigId: "cfg-1", extraScopes: ["ads_read", "business_management"] },
      threads: { appId: "th-id", appSecret: "th-secret" },
      tiktok: { clientKey: "tt-key", clientSecret: "tt-secret", scopes: "user.info.basic,video.upload" },
      linkedin: { clientId: "li-id", clientSecret: "li-secret", version: "202601", organizations: true },
      google: { clientId: "g-id", clientSecret: "g-secret" },
      x: { clientId: "x-id", clientSecret: "x-secret" },
    });
  });

  it("names the env vars of every connector", () => {
    expect(Object.keys(CONNECTOR_ENV).sort()).toEqual(["bluesky", "google", "linkedin", "meta", "threads", "tiktok", "x"]);
    for (const vars of Object.values(CONNECTOR_ENV)) for (const v of vars) expect(VARS).toContain(v);
  });

  it("requires ADMIN_PASSWORD while the dashboard is on", () => {
    vi.stubEnv("ADMIN_PASSWORD", undefined);
    expect(() => loadConfig()).toThrow(/ADMIN_PASSWORD is not set/);
    vi.stubEnv("ADMIN_PASSWORD", "   ");
    expect(() => loadConfig()).toThrow(/ADMIN_PASSWORD is not set/);
    // An API token alone doesn't turn the dashboard off.
    env({ ADMIN_PASSWORD: "", API_TOKEN: "api-token-0123456789" });
    expect(() => loadConfig()).toThrow(/ADMIN_PASSWORD is not set/);
  });

  it("requires API_TOKEN when the dashboard is off", () => {
    env({ DASHBOARD: "off", ADMIN_PASSWORD: "" });
    expect(() => loadConfig()).toThrow(/DASHBOARD=off needs API_TOKEN/);
    env({ API_TOKEN: "api-token-0123456789" });
    expect(loadConfig()).toMatchObject({ dashboard: false, adminPassword: null, apiToken: "api-token-0123456789" });
  });

  it("rejects a short API_TOKEN", () => {
    env({ API_TOKEN: "too-short" });
    expect(() => loadConfig()).toThrow(/API_TOKEN must be at least 16 characters/);
  });

  it("allows WORKER=off only with DATABASE_URL", () => {
    env({ WORKER: "off" });
    expect(() => loadConfig()).toThrow(/WORKER=off only makes sense with DATABASE_URL/);
    env({ DATABASE_URL: "postgres://localhost/postsync" });
    expect(loadConfig()).toMatchObject({ runWorker: false, databaseUrl: "postgres://localhost/postsync" });
  });

  it("rejects invalid values", () => {
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ PUBLIC_BASE_URL: "posts.example.com" }, /PUBLIC_BASE_URL is not a valid URL/],
      [{ PUBLIC_BASE_URL: "http://" }, /PUBLIC_BASE_URL is not a valid URL/],
      [{ WEBHOOK_URL: "not a url" }, /WEBHOOK_URL is not a valid URL/],
      [{ ALLOWED_RETURN_ORIGINS: "https://ok.example.com, app.example.com" }, /ALLOWED_RETURN_ORIGINS must be a comma-separated list of URLs/],
      [{ CORS_ORIGINS: "*" }, /CORS_ORIGINS must be a comma-separated list of URLs/],
      [{ PORT: "eighty" }, /PORT must be a number/],
      [{ DASHBOARD: "maybe" }, /DASHBOARD must be on or off/],
      [{ WORKER: "sometimes" }, /WORKER must be on or off/],
    ];
    for (const [vars, error] of cases) {
      vi.unstubAllEnvs();
      for (const name of VARS) vi.stubEnv(name, undefined);
      env({ DATA_DIR: dataDir, ADMIN_PASSWORD: "hunter22", APP_SECRET: SECRET, ...vars });
      expect(() => loadConfig(), JSON.stringify(vars)).toThrow(error);
    }
  });

  it("generates APP_SECRET once into DATA_DIR/.app-secret and reuses it", () => {
    vi.stubEnv("APP_SECRET", undefined);
    const dir = path.join(dataDir, "nested", "data");
    vi.stubEnv("DATA_DIR", dir);

    const first = loadConfig().secret;
    expect(first.length).toBeGreaterThanOrEqual(32);
    const file = path.join(dir, ".app-secret");
    expect(fs.readFileSync(file, "utf8")).toBe(first + "\n");
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    expect(loadConfig().secret).toBe(first);
    expect(fs.readFileSync(file, "utf8")).toBe(first + "\n");

    // Another data dir gets its own secret.
    vi.stubEnv("DATA_DIR", tempDir());
    expect(loadConfig().secret).not.toBe(first);
  });

  it("prefers APP_SECRET from the environment and rejects a short one", () => {
    expect(loadConfig().secret).toBe(SECRET);
    expect(fs.existsSync(path.join(dataDir, ".app-secret"))).toBe(false);

    vi.stubEnv("APP_SECRET", "short-secret");
    expect(() => loadConfig()).toThrow(/APP_SECRET must be at least 32 characters/);
    vi.stubEnv("APP_SECRET", "x".repeat(31));
    expect(() => loadConfig()).toThrow(/APP_SECRET must be at least 32 characters/);
  });

  it("feeds WEBHOOK_EVENTS through to the running server", async () => {
    env({ WEBHOOK_URL: "https://hooks.example.com/in", WEBHOOK_SECRET: "whsec", WEBHOOK_EVENTS: "target.cancelled" });
    const { calls } = mockFetch([{ method: "POST", match: "https://hooks.example.com/in", reply: () => ({ status: 200 }) }]);
    const app = await buildServer({ config: loadConfig(), storage: sqliteStorage(":memory:"), startWorker: false });
    try {
      const target = { id: "t1" } as any;
      app.postSync.events.emit("target.succeeded", { target });
      app.postSync.events.emit("target.cancelled", { target });
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      await new Promise((r) => setTimeout(r, 20));
      expect(calls.map((c) => c.headers.get("x-post-sync-event"))).toEqual(["target.cancelled"]);
      expect(calls[0].headers.get("x-post-sync-signature")).toMatch(/^sha256=[0-9a-f]{64}$/);
    } finally {
      await app.close();
    }
  });
});
