import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { sqliteStorage } from "post-social-media-sync/sqlite";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE } from "../src/auth.js";
import type { DashboardConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { dashboardConfig, mockFetch, PASSWORD, removeTempDirs } from "./helpers.js";

const apps: FastifyInstance[] = [];

async function start(config: DashboardConfig, opts: { sleep?: (ms: number) => Promise<void>; logLines?: string[] } = {}) {
  const lines = opts.logLines;
  const app = await buildServer({
    config,
    storage: sqliteStorage(":memory:"),
    startWorker: false,
    sleep: opts.sleep ?? (async () => {}),
    logger: lines ? { level: "warn", stream: { write: (line: string) => void lines.push(line) } } : undefined,
  });
  apps.push(app);
  await app.ready();
  return app;
}

afterEach(async () => {
  vi.useRealTimers();
  for (const app of apps.splice(0)) await app.close();
});
afterAll(removeTempDirs);

function setCookies(res: LightMyRequestResponse): string[] {
  const raw = res.headers["set-cookie"];
  return raw === undefined ? [] : Array.isArray(raw) ? raw : [String(raw)];
}

async function login(app: FastifyInstance): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/login", payload: { password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return setCookies(res)[0].split(";")[0];
}

async function authenticated(app: FastifyInstance, cookie: string): Promise<boolean> {
  const session = (await app.inject({ url: "/api/session", headers: { cookie } })).json().authenticated;
  const accounts = (await app.inject({ url: "/api/accounts", headers: { cookie } })).statusCode;
  expect(accounts).toBe(session ? 200 : 401);
  return session;
}

describe("login rate limit behind proxies (TRUST_PROXY)", () => {
  function attempt(app: FastifyInstance, password: string, remoteAddress: string, forwardedFor?: string) {
    return app.inject({
      method: "POST",
      url: "/api/login",
      payload: { password },
      remoteAddress,
      headers: forwardedFor ? { "x-forwarded-for": forwardedFor } : {},
    });
  }

  it("ignores X-Forwarded-For by default, so a direct client can't dodge the limit", async () => {
    const lines: string[] = [];
    const app = await start(dashboardConfig(), { logLines: lines });
    for (let i = 0; i < 5; i++) expect((await attempt(app, "bad", "198.51.100.7", `203.0.113.${i}`)).statusCode).toBe(401);
    expect((await attempt(app, PASSWORD, "198.51.100.7", "203.0.113.200")).statusCode).toBe(429);
    expect((await attempt(app, PASSWORD, "198.51.100.7")).statusCode).toBe(429);
    expect((await attempt(app, PASSWORD, "198.51.100.8", "198.51.100.7")).statusCode).toBe(200);

    // Hints (once) at TRUST_PROXY, for servers that really are behind a proxy.
    const warnings = lines.filter((l) => l.includes("TRUST_PROXY is off"));
    expect(warnings).toHaveLength(1);
  });

  it("keys on the forwarded client address with TRUST_PROXY=true", async () => {
    const app = await start(dashboardConfig({ trustProxy: true }));
    for (let i = 0; i < 5; i++) expect((await attempt(app, "bad", "10.0.0.2", "198.51.100.7")).statusCode).toBe(401);
    expect((await attempt(app, PASSWORD, "10.0.0.2", "198.51.100.7")).statusCode).toBe(429);
    // Another client behind the same proxy isn't locked out.
    expect((await attempt(app, PASSWORD, "10.0.0.2", "203.0.113.9")).statusCode).toBe(200);
  });

  it("believes only the last hop with TRUST_PROXY=1, whatever the client prepends", async () => {
    const app = await start(dashboardConfig({ trustProxy: 1 }));
    for (let i = 0; i < 5; i++) {
      // The client sends its own X-Forwarded-For; the proxy appends the address it saw.
      expect((await attempt(app, "bad", "10.0.0.2", `192.0.2.${i}, 198.51.100.7`)).statusCode).toBe(401);
    }
    expect((await attempt(app, PASSWORD, "10.0.0.2", "192.0.2.99, 198.51.100.7")).statusCode).toBe(429);
    expect((await attempt(app, PASSWORD, "10.0.0.2", "198.51.100.8")).statusCode).toBe(200);
  });

  it("believes X-Forwarded-For only from the listed proxies", async () => {
    const app = await start(dashboardConfig({ trustProxy: ["10.0.0.0/8", "::1"] }));
    for (let i = 0; i < 5; i++) expect((await attempt(app, "bad", "10.1.2.3", "198.51.100.7")).statusCode).toBe(401);
    expect((await attempt(app, PASSWORD, "10.9.9.9", "198.51.100.7")).statusCode).toBe(429);
    expect((await attempt(app, PASSWORD, "10.1.2.3", "198.51.100.8")).statusCode).toBe(200);

    // A client outside the list is keyed on its own address, whatever it claims.
    for (let i = 0; i < 5; i++) expect((await attempt(app, "bad", "203.0.113.5", `198.51.100.${20 + i}`)).statusCode).toBe(401);
    expect((await attempt(app, PASSWORD, "203.0.113.5", "198.51.100.30")).statusCode).toBe(429);
  });

  it("accepts every address form TRUST_PROXY allows", async () => {
    const trustProxy = ["loopback", "uniquelocal", "linklocal", "fd00::/8", "172.16.0.0/255.240.0.0", "203.0.113.1"];
    const app = await start(dashboardConfig({ trustProxy }));
    for (let i = 0; i < 5; i++) expect((await attempt(app, "bad", "172.17.0.2", "198.51.100.7")).statusCode).toBe(401);
    expect((await attempt(app, PASSWORD, "203.0.113.1", "198.51.100.7")).statusCode).toBe(429);
    expect((await attempt(app, PASSWORD, "172.17.0.2", "198.51.100.8")).statusCode).toBe(200);
  });
});

describe("logging out", () => {
  it("ends every session, not just the cookie that logged out", async () => {
    const config = dashboardConfig();
    const app = await start(config);
    const laptop = await login(app);
    const phone = await login(app);
    expect(await authenticated(app, laptop)).toBe(true);
    expect(await authenticated(app, phone)).toBe(true);

    const out = await app.inject({ method: "POST", url: "/api/logout", headers: { cookie: phone } });
    expect(out.statusCode).toBe(200);
    expect(setCookies(out)[0]).toMatch(new RegExp(`^${SESSION_COOKIE}=;`));
    expect(await authenticated(app, phone)).toBe(false);
    expect(await authenticated(app, laptop)).toBe(false);

    const file = path.join(config.dataDir, ".sessions-not-before");
    expect(Number(fs.readFileSync(file, "utf8"))).toBeGreaterThan(0);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    // Logging in again works.
    expect(await authenticated(app, await login(app))).toBe(true);
  });

  it("accepts a login made in the same millisecond as a logout", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 9, 2, 12));
    const app = await start(dashboardConfig());
    const old = await login(app);
    await app.inject({ method: "POST", url: "/api/logout", headers: { cookie: old } });
    const fresh = await login(app);
    expect(await authenticated(app, old)).toBe(false);
    expect(await authenticated(app, fresh)).toBe(true);
  });

  it("needs a valid session to log everyone out", async () => {
    const config = dashboardConfig();
    const app = await start(config);
    const cookie = await login(app);
    for (const headers of [{}, { cookie: `${SESSION_COOKIE}=${Date.now() + 60_000}.forged` }]) {
      const out = await app.inject({ method: "POST", url: "/api/logout", headers });
      expect(out.statusCode).toBe(200);
      expect(setCookies(out)[0]).toMatch(new RegExp(`^${SESSION_COOKIE}=;`));
    }
    expect(await authenticated(app, cookie)).toBe(true);
    expect(fs.existsSync(path.join(config.dataDir, ".sessions-not-before"))).toBe(false);
  });

  it("survives a restart with the same DATA_DIR", async () => {
    const config = dashboardConfig();
    const first = await start(config);
    const kept = await login(first);
    const stolen = await login(first);
    await first.inject({ method: "POST", url: "/api/logout", headers: { cookie: kept } });
    await first.close();

    const second = await start(config);
    expect(await authenticated(second, stolen)).toBe(false);
    expect(await authenticated(second, kept)).toBe(false);
    expect(await authenticated(second, await login(second))).toBe(true);

    // A server with another data dir (and the same secret) knows nothing of it.
    const other = await start(dashboardConfig());
    expect(await authenticated(other, stolen)).toBe(true);
  });

  it("reaches replicas sharing DATA_DIR within a few seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.UTC(2026, 9, 2, 12);
    vi.setSystemTime(t0);
    const config = dashboardConfig();
    const a = await start(config);
    const b = await start(config);
    const cookie = await login(a);
    expect(await authenticated(b, cookie)).toBe(true);

    vi.setSystemTime(t0 + 1000);
    await a.inject({ method: "POST", url: "/api/logout", headers: { cookie } });
    expect(await authenticated(a, cookie)).toBe(false);
    vi.setSystemTime(t0 + 6000);
    expect(await authenticated(b, cookie)).toBe(false);
  });
});

describe("webhook retries", () => {
  it("wait through the server's sleep option", async () => {
    const hook = "https://hooks.example.com/in";
    const { calls } = mockFetch([{ method: "POST", match: hook, reply: () => ({ status: 503 }) }]);
    const sleep = vi.fn(async (_ms: number) => {});
    const app = await start(dashboardConfig({ webhook: { url: hook, secret: null, events: null } }), { sleep });
    app.postSync.events.emit("target.succeeded", { target: { id: "t1" } as any });
    await vi.waitFor(() => expect(calls).toHaveLength(4));
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual(expect.arrayContaining([1000, 4000, 16000]));
  });
});

describe("long uploads", () => {
  it("aren't cut off by a request timeout", async () => {
    const app = await start(dashboardConfig());
    // Node's own default (300 s) would answer 408 to a slow multi-GB upload.
    expect(app.server.requestTimeout).toBe(0);
  });
});
