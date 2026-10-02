import crypto from "node:crypto";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { sqliteStorage } from "post-social-media-sync/sqlite";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE } from "../src/auth.js";
import type { DashboardConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { signWebhook } from "../src/webhooks.js";
import {
  API_TOKEN,
  blueskyRoutes,
  dashboardConfig,
  mockFetch,
  multipart,
  PASSWORD,
  PNG,
  removeTempDirs,
  SITE,
  TEST_SECRET,
  uniqueHandle,
  type MockCall,
} from "./helpers.js";

const apps: FastifyInstance[] = [];

async function start(overrides: Partial<DashboardConfig> = {}, opts: { startWorker?: boolean } = {}): Promise<FastifyInstance> {
  const app = await buildServer({
    config: dashboardConfig(overrides),
    storage: sqliteStorage(":memory:"),
    startWorker: opts.startWorker ?? false,
    sleep: async () => {},
  });
  apps.push(app);
  await app.ready();
  return app;
}

afterEach(async () => {
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

const bearer = (owner?: string): Record<string, string> => ({
  authorization: `Bearer ${API_TOKEN}`,
  ...(owner === undefined ? {} : { "x-owner-id": owner }),
});

/** A session cookie signed the way the dashboard signs them. */
function signedCookie(expires: number, secret = TEST_SECRET): string {
  const sig = crypto.createHmac("sha256", secret).update(`session:${expires}`).digest("base64url");
  return `${SESSION_COOKIE}=${expires}.${sig}`;
}

function api(app: FastifyInstance, method: InjectOptions["method"], url: string, headers: Record<string, string>, payload?: unknown) {
  return app.inject({ method, url: `/api${url}`, headers, ...(payload === undefined ? {} : { payload: payload as any }) });
}

async function connectBluesky(app: FastifyInstance, headers: Record<string, string>, handle = uniqueHandle()) {
  const res = await api(app, "POST", "/connect/bluesky/credentials", headers, { fields: { identifier: handle, appPassword: "app-pass-1234" } });
  expect(res.statusCode).toBe(201);
  return res.json().accounts[0] as { id: string; ownerId: string; platform: string; username: string };
}

describe("password login", () => {
  it("sets an httpOnly session cookie and reports the session", async () => {
    const app = await start();
    expect((await app.inject({ url: "/api/session" })).json()).toEqual({ authenticated: false });

    const res = await app.inject({ method: "POST", url: "/api/login", payload: { password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const [cookie] = setCookies(res);
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=\\d+\\.[\\w-]+;`));
    expect(cookie).toMatch(/; HttpOnly/i);
    expect(cookie).toMatch(/; SameSite=Lax/i);
    expect(cookie).toMatch(/; Path=\//i);
    expect(cookie).toMatch(/; Secure/i); // siteUrl is https

    const session = cookie.split(";")[0];
    expect((await app.inject({ url: "/api/session", headers: { cookie: session } })).json()).toEqual({ authenticated: true });
    expect((await app.inject({ url: "/api/accounts", headers: { cookie: session } })).statusCode).toBe(200);

    const out = await app.inject({ method: "POST", url: "/api/logout", headers: { cookie: session } });
    expect(out.statusCode).toBe(200);
    expect(setCookies(out)[0]).toMatch(new RegExp(`^${SESSION_COOKIE}=;.*Expires=Thu, 01 Jan 1970`, "i"));
  });

  it("doesn't mark the cookie Secure on a plain-http site", async () => {
    const app = await start({ siteUrl: "http://localhost:3000" });
    const res = await app.inject({ method: "POST", url: "/api/login", payload: { password: PASSWORD } });
    expect(setCookies(res)[0]).not.toMatch(/Secure/i);
  });

  it("rejects a wrong password with 401 and no cookie", async () => {
    const app = await start();
    const res = await app.inject({ method: "POST", url: "/api/login", payload: { password: "nope" } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("Wrong password.");
    expect(setCookies(res)).toEqual([]);
    expect((await app.inject({ method: "POST", url: "/api/login", payload: {} })).statusCode).toBe(401);
  });

  it("rate-limits an address after 5 failed attempts", async () => {
    const app = await start();
    const attempt = (password: string, remoteAddress = "198.51.100.7") =>
      app.inject({ method: "POST", url: "/api/login", payload: { password }, remoteAddress });
    for (let i = 0; i < 5; i++) expect((await attempt("bad")).statusCode).toBe(401);

    // Locked out, even with the right password.
    const locked = await attempt(PASSWORD);
    expect(locked.statusCode).toBe(429);
    const retryAfter = Number(locked.headers["retry-after"]);
    expect(retryAfter).toBeGreaterThan(800);
    expect(retryAfter).toBeLessThanOrEqual(900);
    expect(locked.json().error).toMatch(/Too many attempts/);
    expect(setCookies(locked)).toEqual([]);

    // Other addresses are unaffected.
    expect((await attempt(PASSWORD, "203.0.113.9")).statusCode).toBe(200);
  });

  it("refuses forged, tampered and expired cookies", async () => {
    const app = await start();
    const valid = await login(app);
    const [, value] = valid.split("=");
    const [expires, sig] = value.split(".");
    const cases = [
      `${SESSION_COOKIE}=garbage`,
      `${SESSION_COOKIE}=${Number(expires) + 1000}.${sig}`, // expiry pushed out without re-signing
      signedCookie(Date.now() + 60_000, "another-secret-another-secret-another-secret"),
      signedCookie(Date.now() - 1000), // properly signed but expired
    ];
    for (const cookie of cases) {
      expect((await app.inject({ url: "/api/accounts", headers: { cookie } })).statusCode, cookie).toBe(401);
      expect((await app.inject({ url: "/api/session", headers: { cookie } })).json()).toEqual({ authenticated: false });
    }
    expect((await app.inject({ url: "/api/accounts", headers: { cookie: signedCookie(Date.now() + 60_000) } })).statusCode).toBe(200);
  });
});

describe("dashboard and headless modes", () => {
  it("serves the web UI when the dashboard is on", async () => {
    const app = await start();
    const page = await app.inject({ url: "/" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toMatch(/text\/html/);
    expect(page.body).toContain("<title>Post Sync</title>");
    expect((await app.inject({ url: "/app.js" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/styles.css" })).statusCode).toBe(200);
  });

  it("serves only the API when DASHBOARD=off", async () => {
    const app = await start({ dashboard: false, adminPassword: null });
    expect((await app.inject({ url: "/" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/index.html" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/app.js" })).statusCode).toBe(404);

    // No password login in headless mode.
    expect((await app.inject({ method: "POST", url: "/api/login", payload: { password: PASSWORD } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/logout" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/api/session" })).statusCode).toBe(404);
    // Even a correctly signed session cookie is ignored.
    expect((await app.inject({ url: "/api/accounts", headers: { cookie: signedCookie(Date.now() + 60_000) } })).statusCode).toBe(401);

    expect((await app.inject({ url: "/api/accounts", headers: bearer() })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/meta", headers: bearer() })).statusCode).toBe(200);
    expect((await app.inject({ url: "/healthz" })).json()).toEqual({ ok: true });
  });

  it("answers /healthz without auth", async () => {
    const app = await start();
    const res = await app.inject({ url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

describe("API authentication", () => {
  const protectedRoutes: Array<[InjectOptions["method"], string]> = [
    ["GET", "/api/meta"],
    ["GET", "/api/platforms"],
    ["GET", "/api/accounts"],
    ["GET", "/api/accounts/a1"],
    ["DELETE", "/api/accounts/a1"],
    ["POST", "/api/accounts/a1/check"],
    ["GET", "/api/connect/meta"],
    ["POST", "/api/connect/meta"],
    ["POST", "/api/connect/bluesky/credentials"],
    ["POST", "/api/media"],
    ["POST", "/api/media/from-url"],
    ["GET", "/api/media/m1"],
    ["DELETE", "/api/media/m1"],
    ["POST", "/api/posts/validate"],
    ["POST", "/api/posts"],
    ["GET", "/api/posts"],
    ["GET", "/api/posts/p1"],
    ["DELETE", "/api/posts/p1"],
    ["POST", "/api/targets/t1/retry"],
    ["POST", "/api/targets/t1/cancel"],
  ];

  it("requires a login or token on every API route", async () => {
    const app = await start();
    for (const [method, url] of protectedRoutes) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
      expect(res.json().error).toBe("Not logged in.");
    }
  });

  it("rejects a wrong or missing API token", async () => {
    const app = await start();
    const headers = [
      { authorization: "Bearer wrong-token-0123456789abcdef" },
      { authorization: `Bearer ${API_TOKEN}x` },
      { authorization: `Basic ${API_TOKEN}` },
      { authorization: "Bearer " },
    ];
    for (const h of headers) {
      expect((await app.inject({ url: "/api/accounts", headers: h })).statusCode, h.authorization).toBe(401);
      expect((await app.inject({ url: "/api/meta", headers: h })).statusCode, h.authorization).toBe(401);
    }
  });

  it("rejects bearer tokens when no API_TOKEN is configured", async () => {
    const app = await start({ apiToken: null });
    expect((await app.inject({ url: "/api/accounts", headers: bearer() })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/accounts", headers: { authorization: "Bearer " } })).statusCode).toBe(401);
  });

  it("answers 400 (not 500) for a malformed X-Owner-Id", async () => {
    const app = await start();
    for (const owner of ["has space", "a".repeat(201), "../etc", "émile", ""]) {
      for (const url of ["/api/accounts", "/api/meta"]) {
        const res = await app.inject({ url, headers: bearer(owner) });
        expect(res.statusCode, `${url} ${JSON.stringify(owner)}`).toBe(400);
        expect(res.json()).toEqual({ error: expect.stringMatching(/^X-Owner-Id must be/) });
      }
    }
    // A wrong token is still a 401, whatever the owner header says.
    expect((await app.inject({ url: "/api/accounts", headers: { authorization: "Bearer nope", "x-owner-id": "has space" } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/accounts", headers: bearer("user_1.a:b@c|d-e") })).statusCode).toBe(200);
  });

  it("answers errors from the dashboard's own routes as { error } without internal details", async () => {
    const app = await start();
    const badJson = await app.inject({ method: "POST", url: "/api/login", payload: "{nope", headers: { "content-type": "application/json" } });
    expect(badJson.statusCode).toBe(400);
    expect(Object.keys(badJson.json())).toEqual(["error"]);

    vi.spyOn(app.postSync, "describe").mockRejectedValue(new Error("connection string postgres://admin:pw@db"));
    const crashed = await app.inject({ url: "/api/meta", headers: bearer() });
    expect(crashed.statusCode).toBe(500);
    expect(crashed.json()).toEqual({ error: "Internal server error" });
  });

  it("acts as owner \"default\" for the dashboard session and plain API token", async () => {
    mockFetch(blueskyRoutes());
    const app = await start();
    const cookie = await login(app);
    const account = await connectBluesky(app, { cookie });
    expect(account.ownerId).toBe("default");

    for (const headers of [{ cookie }, bearer(), bearer("default")]) {
      const res = await api(app, "GET", "/accounts", headers);
      expect(res.json().accounts.map((a: any) => a.id)).toEqual([account.id]);
    }
    expect((await api(app, "GET", "/accounts", bearer("u1"))).json().accounts).toEqual([]);

    const viaToken = await connectBluesky(app, bearer());
    expect(viaToken.ownerId).toBe("default");
    const viaOwner = await connectBluesky(app, bearer("u1"));
    expect(viaOwner.ownerId).toBe("u1");
  });

  it("keeps owners apart", async () => {
    mockFetch(blueskyRoutes());
    const app = await start();
    const cookie = await login(app);
    const u1 = bearer("u1");
    const u2 = bearer("u2");

    const account = await connectBluesky(app, u1);
    const { payload, contentType } = await multipart(formWithPng());
    const up = await app.inject({ method: "POST", url: "/api/media", payload, headers: { ...u1, "content-type": contentType } });
    expect(up.statusCode).toBe(201);
    const media = up.json().media[0];
    const created = await api(app, "POST", "/posts", u1, { text: "Only mine", mediaIds: [media.id], targets: [{ accountId: account.id }] });
    expect(created.statusCode).toBe(201);
    const post = created.json().post;
    const targetId = post.targets[0].id;

    for (const other of [u2, { cookie }, bearer()]) {
      expect((await api(app, "GET", "/accounts", other)).json().accounts).toEqual([]);
      expect((await api(app, "GET", `/accounts/${account.id}`, other)).statusCode).toBe(404);
      expect((await api(app, "DELETE", `/accounts/${account.id}`, other)).statusCode).toBe(404);
      expect((await api(app, "POST", `/accounts/${account.id}/check`, other)).statusCode).toBe(404);
      expect((await api(app, "GET", "/posts", other)).json().posts).toEqual([]);
      expect((await api(app, "GET", `/posts/${post.id}`, other)).statusCode).toBe(404);
      expect((await api(app, "DELETE", `/posts/${post.id}`, other)).statusCode).toBe(404);
      expect((await api(app, "GET", `/media/${media.id}`, other)).statusCode).toBe(404);
      expect((await api(app, "DELETE", `/media/${media.id}`, other)).statusCode).toBe(404);
      expect((await api(app, "POST", `/targets/${targetId}/cancel`, other)).statusCode).toBe(409);
      // Someone else's account and media can't be used either.
      expect((await api(app, "POST", "/posts", other, { text: "x", targets: [{ accountId: account.id }] })).statusCode).toBe(400);
      expect((await api(app, "POST", "/posts", other, { text: "x", mediaIds: [media.id], platforms: ["bluesky"] })).statusCode).toBe(400);
    }

    // Untouched for its owner.
    expect((await api(app, "GET", "/accounts", u1)).json().accounts).toHaveLength(1);
    const mine = await api(app, "GET", `/posts/${post.id}`, u1);
    expect(mine.statusCode).toBe(200);
    expect(mine.json().post.targets[0].status).toBe("queued");
    expect((await api(app, "GET", `/media/${media.id}`, u1)).statusCode).toBe(200);
  });
});

function formWithPng(): FormData {
  const form = new FormData();
  form.append("file", new Blob([PNG], { type: "image/png" }), "dot.png");
  return form;
}

describe("browser protections", () => {
  it("blocks cross-site writes made with the session cookie, allows same-origin ones", async () => {
    const { calls } = mockFetch(blueskyRoutes());
    const app = await start();
    const cookie = await login(app);
    const body = { fields: { identifier: uniqueHandle(), appPassword: "app-pass-1234" } };

    const evil = await api(app, "POST", "/connect/bluesky/credentials", { cookie, origin: "https://evil.example" }, body);
    expect(evil.statusCode).toBe(403);
    expect(evil.json().error).toMatch(/Cross-origin/);
    expect(calls).toHaveLength(0);
    expect((await api(app, "POST", "/posts", { cookie, origin: "https://evil.example" }, { text: "x", platforms: ["bluesky"] })).statusCode).toBe(403);

    const same = await api(app, "POST", "/connect/bluesky/credentials", { cookie, origin: SITE }, body);
    expect(same.statusCode).toBe(201);
    const accountId = same.json().accounts[0].id;
    expect((await api(app, "DELETE", `/accounts/${accountId}`, { cookie, origin: "https://evil.example" })).statusCode).toBe(403);
    expect((await api(app, "DELETE", `/accounts/${accountId}`, { cookie, origin: SITE })).statusCode).toBe(200);

    // Reads are not affected.
    expect((await api(app, "GET", "/accounts", { cookie, origin: "https://evil.example" })).statusCode).toBe(200);
  });

  it("adds security headers to API, UI and error responses", async () => {
    const app = await start();
    const cookie = await login(app);
    const responses = [
      await app.inject({ url: "/api/accounts", headers: { cookie } }),
      await app.inject({ url: "/api/accounts" }),
      await app.inject({ url: "/api/meta", headers: { cookie } }),
      await app.inject({ url: "/api/nope", headers: { cookie } }),
      await app.inject({ url: "/api/session" }),
      await app.inject({ url: "/" }),
    ];
    for (const res of responses) {
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.headers["referrer-policy"]).toBe("same-origin");
      expect(res.headers["x-post-sync-unmatched"]).toBeUndefined();
    }
  });

  it("answers CORS preflights for configured origins only", async () => {
    const app = await start({ corsOrigins: ["https://app.other.example"] });
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/api/posts",
      headers: {
        origin: "https://app.other.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, authorization, x-owner-id",
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("https://app.other.example");
    expect(preflight.headers["access-control-allow-credentials"]).toBe("true");
    expect(preflight.headers["access-control-allow-methods"]).toMatch(/POST/);
    expect(preflight.headers["access-control-allow-headers"]).toBe("content-type, authorization, x-owner-id");
    expect(preflight.headers.vary).toMatch(/Origin/);

    const foreign = await app.inject({
      method: "OPTIONS",
      url: "/api/posts",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    expect(foreign.headers["access-control-allow-origin"]).toBeUndefined();

    const get = await app.inject({ url: "/api/accounts", headers: { ...bearer(), origin: "https://app.other.example" } });
    expect(get.statusCode).toBe(200);
    expect(get.headers["access-control-allow-origin"]).toBe("https://app.other.example");

    // The CORS origin may also write with the session cookie.
    const cookie = await login(app);
    const write = await api(app, "POST", "/posts/validate", { cookie, origin: "https://app.other.example" }, { text: "x", platforms: ["bluesky"] });
    expect(write.statusCode).not.toBe(403);
  });

  it("sends no CORS headers when no origins are configured", async () => {
    const app = await start();
    const res = await app.inject({ url: "/api/accounts", headers: { ...bearer(), origin: "https://app.other.example" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/api/posts",
      headers: { origin: "https://app.other.example", "access-control-request-method": "POST" },
    });
    expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

const META_KEYS = { meta: { appId: "meta-app", appSecret: "meta-secret" } };

describe("/api/meta", () => {
  it("describes the engine plus the env vars that enable each connector", async () => {
    const app = await start({ platforms: META_KEYS });
    const res = await app.inject({ url: "/api/meta", headers: bearer() });
    expect(res.statusCode).toBe(200);
    const meta = res.json();
    expect(meta.publicBaseUrl).toBe(SITE);
    expect(meta.publicUrl).toBe(`${SITE}/api`);
    expect(meta.platforms.map((p: any) => p.id)).toEqual(expect.arrayContaining(["facebook", "instagram", "bluesky", "x"]));

    const byId = Object.fromEntries(meta.connectors.map((c: any) => [c.id, c]));
    expect(Object.keys(byId).sort()).toEqual(["bluesky", "google", "linkedin", "meta", "threads", "tiktok", "x"]);
    for (const c of meta.connectors) expect(Array.isArray(c.envVars)).toBe(true);
    expect(byId.meta).toMatchObject({
      configured: true,
      envVars: ["META_APP_ID", "META_APP_SECRET"],
      redirectUri: `${SITE}/api/oauth/meta/callback`,
    });
    expect(byId.tiktok).toMatchObject({ configured: false, envVars: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"] });
    expect(byId.google.envVars).toEqual(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
    expect(byId.bluesky).toMatchObject({ configured: true, kind: "credentials", envVars: [], redirectUri: null });
  });
});

describe("connecting accounts", () => {
  it("sends the browser to the platform's login when its keys are set", async () => {
    const app = await start({ platforms: META_KEYS });
    const cookie = await login(app);
    const res = await app.inject({ url: "/api/connect/meta?returnTo=/%23accounts", headers: { cookie } });
    expect(res.statusCode).toBe(302);
    const location = new URL(String(res.headers.location));
    expect(location.origin + location.pathname).toMatch(/^https:\/\/www\.facebook\.com\/v[\d.]+\/dialog\/oauth$/);
    expect(location.searchParams.get("client_id")).toBe("meta-app");
    expect(location.searchParams.get("redirect_uri")).toBe(`${SITE}/api/oauth/meta/callback`);
    expect(location.searchParams.get("state")).toMatch(/^[\w-]{20,}$/);
  });

  it("sends the browser back with an error when the platform isn't set up", async () => {
    const app = await start();
    const cookie = await login(app);
    const res = await app.inject({ url: "/api/connect/meta?returnTo=/%23accounts", headers: { cookie } });
    expect(res.statusCode).toBe(302);
    const location = new URL(String(res.headers.location));
    expect(location.origin + location.pathname).toBe(`${SITE}/`);
    expect(location.hash).toBe("#accounts");
    expect(location.searchParams.get("postsync")).toBe("error");
    expect(location.searchParams.get("connector")).toBe("meta");
    expect(location.searchParams.get("error")).toMatch(/isn't set up/);
  });

  it("only returns browsers to allowed origins", async () => {
    const app = await start({ platforms: META_KEYS });
    const cookie = await login(app);
    for (const returnTo of ["https://evil.example/x", "//evil.example/x", "javascript:alert(1)"]) {
      const res = await app.inject({ url: `/api/connect/meta?returnTo=${encodeURIComponent(returnTo)}`, headers: { cookie } });
      expect(res.statusCode, returnTo).toBe(400);
    }
    const foreign = await app.inject({ url: `/api/connect/meta?returnTo=${encodeURIComponent("https://app.other.example/settings")}`, headers: { cookie } });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().error).toMatch(/isn't allowed/);
    const own = await app.inject({ url: `/api/connect/meta?returnTo=${encodeURIComponent(`${SITE}/somewhere`)}`, headers: { cookie } });
    expect(own.statusCode).toBe(302);

    const allowing = await start({ platforms: META_KEYS, allowedReturnOrigins: ["https://app.other.example"] });
    const cookie2 = await login(allowing);
    const ok = await allowing.inject({
      url: `/api/connect/meta?returnTo=${encodeURIComponent("https://app.other.example/settings")}`,
      headers: { cookie: cookie2 },
    });
    expect(ok.statusCode).toBe(302);
    expect(String(ok.headers.location)).toMatch(/^https:\/\/www\.facebook\.com\//);
  });

  it("completes an OAuth login at /api/oauth/<connector>/callback for the owner who started it", async () => {
    const app = await start({
      platforms: { linkedin: { clientId: "li-id", clientSecret: "li-secret" } },
      allowedReturnOrigins: ["https://app.other.example"],
    });

    // A backend starts the login for one of its users and sends the browser to the returned URL.
    const started = await api(app, "POST", "/connect/linkedin", bearer("u1"), { returnTo: "https://app.other.example/settings" });
    expect(started.statusCode).toBe(200);
    const authUrl = new URL(started.json().url);
    expect(authUrl.origin + authUrl.pathname).toBe("https://www.linkedin.com/oauth/v2/authorization");
    expect(authUrl.searchParams.get("redirect_uri")).toBe(`${SITE}/api/oauth/linkedin/callback`);
    const state = authUrl.searchParams.get("state")!;

    const { calls } = mockFetch([
      {
        method: "POST",
        match: "https://www.linkedin.com/oauth/v2/accessToken",
        reply: () => ({ json: { access_token: "LI_TOKEN", expires_in: 5184000 } }),
      },
      { method: "GET", match: "https://api.linkedin.com/v2/userinfo", reply: () => ({ json: { sub: "abc123", name: "Tenzin" } }) },
    ]);
    // The platform redirects the browser here: no login cookie or token involved.
    const callback = await app.inject({ url: `/api/oauth/linkedin/callback?code=CODE&state=${state}` });
    expect(callback.statusCode).toBe(302);
    const back = new URL(String(callback.headers.location));
    expect(back.origin + back.pathname).toBe("https://app.other.example/settings");
    expect(Object.fromEntries(back.searchParams)).toEqual({ postsync: "connected", connector: "LinkedIn", count: "1" });
    expect(Object.fromEntries(calls[0].body as URLSearchParams)).toMatchObject({
      code: "CODE",
      grant_type: "authorization_code",
      redirect_uri: `${SITE}/api/oauth/linkedin/callback`,
    });

    const accounts = (await api(app, "GET", "/accounts", bearer("u1"))).json().accounts;
    expect(accounts).toEqual([expect.objectContaining({ platform: "linkedin", name: "Tenzin", ownerId: "u1", status: "active" })]);
    expect((await api(app, "GET", "/accounts", bearer())).json().accounts).toEqual([]);

    // The state is single-use.
    const replay = await app.inject({ url: `/api/oauth/linkedin/callback?code=CODE&state=${state}` });
    expect(replay.statusCode).toBe(302);
    const replayed = new URL(String(replay.headers.location));
    expect(replayed.origin + replayed.pathname + replayed.hash).toBe(`${SITE}/#accounts`);
    expect(replayed.searchParams.get("postsync")).toBe("error");
    expect(calls).toHaveLength(2);
  });
});

describe("publishing through the HTTP API", () => {
  it("connects Bluesky, uploads media, posts and publishes", async () => {
    const { calls } = mockFetch(blueskyRoutes());
    const app = await start();
    const cookie = await login(app);
    const handle = uniqueHandle();

    const connected = await api(app, "POST", "/connect/bluesky/credentials", { cookie }, { fields: { identifier: handle, appPassword: "app-pass-1234" } });
    expect(connected.statusCode).toBe(201);
    expect(connected.body).not.toContain("app-pass-1234");
    const account = connected.json().accounts[0];
    expect(account).toMatchObject({ platform: "bluesky", connector: "bluesky", ownerId: "default", username: handle, status: "active" });

    const { payload, contentType } = await multipart(formWithPng());
    const up = await app.inject({ method: "POST", url: "/api/media", payload, headers: { cookie, "content-type": contentType } });
    expect(up.statusCode).toBe(201);
    const media = up.json().media[0];
    expect(media).toMatchObject({ kind: "image", mime: "image/png", size: PNG.length, ownerId: "default" });
    expect(media.url.startsWith(`${SITE}/api/media/`)).toBe(true);

    // The signed media URL is public (platforms download from it); a tampered one isn't.
    const file = await app.inject({ url: new URL(media.url).pathname });
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-type"]).toBe("image/png");
    expect(file.rawPayload.equals(PNG)).toBe(true);
    const tampered = new URL(media.url).pathname.replace(/\/media\/[^/]+\//, "/media/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/");
    expect((await app.inject({ url: tampered })).statusCode).toBe(404);

    const validated = await api(app, "POST", "/posts/validate", { cookie }, { text: "x".repeat(301), targets: [{ accountId: account.id }] });
    expect(validated.statusCode).toBe(200);
    expect(validated.json().issues[0].errors[0]).toMatch(/300 characters/);

    const created = await api(app, "POST", "/posts", { cookie }, { text: "Hello #world", mediaIds: [media.id], targets: [{ accountId: account.id }] });
    expect(created.statusCode).toBe(201);
    const post = created.json().post;
    expect(post.targets).toEqual([expect.objectContaining({ status: "queued", accountId: account.id, platform: "bluesky" })]);

    expect(await app.postSync.worker.runDue()).toEqual({ processed: 1 });

    const done = (await api(app, "GET", `/posts/${post.id}`, { cookie })).json().post;
    expect(done.targets[0]).toMatchObject({
      status: "succeeded",
      attempts: 1,
      remoteUrl: `https://bsky.app/profile/${handle}/post/3kp`,
    });
    const record = calls.find((c) => c.url.pathname.endsWith("com.atproto.repo.createRecord"))!;
    const sent = JSON.parse(String(record.body));
    expect(sent.record.text).toBe("Hello #world");
    expect(sent.record.embed.images).toHaveLength(1);
    expect(calls.some((c) => c.url.pathname.endsWith("com.atproto.repo.uploadBlob"))).toBe(true);

    const list = (await api(app, "GET", "/posts", { cookie })).json();
    expect(list.posts.map((p: any) => p.id)).toEqual([post.id]);

    // Media a post uses can't be deleted; removing the post from the history also removes its now unused media.
    expect((await api(app, "DELETE", `/media/${media.id}`, { cookie })).statusCode).toBe(409);
    expect((await api(app, "DELETE", `/posts/${post.id}`, { cookie })).statusCode).toBe(200);
    expect((await api(app, "GET", `/media/${media.id}`, { cookie })).statusCode).toBe(404);
    expect((await app.inject({ url: new URL(media.url).pathname })).statusCode).toBe(404);
    expect((await api(app, "DELETE", `/accounts/${account.id}`, { cookie })).statusCode).toBe(200);
    expect((await api(app, "GET", "/accounts", { cookie })).json().accounts).toEqual([]);
  });

  it("runs the worker in-process when asked and stops it on close", async () => {
    mockFetch(blueskyRoutes());
    const app = await start({}, { startWorker: true });
    expect(app.postSync.worker.isRunning()).toBe(true);

    const account = await connectBluesky(app, bearer("u1"));
    const created = await api(app, "POST", "/posts", bearer("u1"), { text: "In the background", targets: [{ accountId: account.id }] });
    expect(created.statusCode).toBe(201);
    const postId = created.json().post.id;
    await vi.waitFor(async () => {
      const post = (await api(app, "GET", `/posts/${postId}`, bearer("u1"))).json().post;
      expect(post.targets[0].status).toBe("succeeded");
    });

    await app.close();
    expect(app.postSync.worker.isRunning()).toBe(false);
  });

  it("doesn't start the worker when startWorker is false", async () => {
    const app = await start();
    expect(app.postSync.worker.isRunning()).toBe(false);
  });

  it("forwards engine events to the webhook, signed", async () => {
    const hook = "https://hooks.example.com/post-sync";
    const deliveries: MockCall[] = [];
    mockFetch([
      ...blueskyRoutes(),
      {
        method: "POST",
        match: hook,
        reply: (call) => {
          deliveries.push(call);
          return { status: 204 };
        },
      },
    ]);
    const app = await start({ webhook: { url: hook, secret: "whsec_test", events: null } });
    const account = await connectBluesky(app, bearer("u1"));
    const created = await api(app, "POST", "/posts", bearer("u1"), { text: "Hooked", targets: [{ accountId: account.id }] });
    expect(created.statusCode).toBe(201);
    await app.postSync.worker.runDue();

    const events = () => deliveries.map((d) => d.headers.get("x-post-sync-event"));
    await vi.waitFor(() => expect(events()).toContain("target.succeeded"));
    expect(events()).toEqual(expect.arrayContaining(["account.connected", "post.created", "target.started", "target.succeeded"]));
    expect(events()).not.toContain("target.progress");

    for (const d of deliveries) {
      const body = String(d.body);
      const timestamp = d.headers.get("x-post-sync-timestamp")!;
      expect(d.headers.get("x-post-sync-signature")).toBe(signWebhook("whsec_test", timestamp, body));
      const parsed = JSON.parse(body);
      expect(parsed.id).toBe(d.headers.get("x-post-sync-delivery"));
      expect(parsed.event).toBe(d.headers.get("x-post-sync-event"));
    }
    const succeeded = JSON.parse(String(deliveries.find((d) => d.headers.get("x-post-sync-event") === "target.succeeded")!.body));
    expect(succeeded.data.target).toMatchObject({ ownerId: "u1", postId: created.json().post.id, status: "succeeded" });
  });
});
