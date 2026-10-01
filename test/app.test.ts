import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { Config } from "../src/config.js";
import { hasFfmpeg } from "../src/media.js";
import { clearBlueskySessions } from "../src/platforms/bluesky.js";
import { facebook } from "../src/platforms/facebook.js";
import { instagram } from "../src/platforms/instagram.js";
import { threads } from "../src/platforms/threads.js";
import { tiktokPlatform } from "../src/platforms/tiktok.js";
import { x } from "../src/platforms/x.js";
import { youtube } from "../src/platforms/youtube.js";
import { validateForPlatform, withDefaults } from "../src/posts.js";
import type { Platform, PublishInput } from "../src/platforms/types.js";
import { fakeMedia, json, mockFetch, testConfig } from "./helpers.js";

function input(platform: Platform, partial: Partial<PublishInput>): PublishInput {
  return { text: "", title: null, media: [], ...partial, options: withDefaults(platform, partial.options) };
}

describe("validation", () => {
  const config = testConfig();

  it("enforces per-platform rules", () => {
    expect(validateForPlatform(instagram, input(instagram, { text: "hi" }), config)).toEqual(["Instagram needs a photo or video."]);
    expect(validateForPlatform(tiktokPlatform, input(tiktokPlatform, { text: "hi" }), config)).toEqual([
      "TikTok needs a video.",
      "Choose who can view this TikTok post.",
    ]);
    expect(
      validateForPlatform(youtube, input(youtube, { text: "hi", media: [fakeMedia(config, { kind: "image" })] }), config),
    ).toContain("YouTube doesn't support photo posts here, only video.");
    expect(validateForPlatform(x, input(x, { text: "a".repeat(281) }), config)).toEqual(["X allows 280 characters; this caption has 281."]);
    expect(validateForPlatform(x, input(x, { text: "a".repeat(281), options: { premium: true } }), config)).toEqual([]);
    expect(
      validateForPlatform(
        facebook,
        input(facebook, { text: "x", media: [fakeMedia(config, { kind: "image" }), fakeMedia(config, { kind: "video" })] }),
        config,
      ),
    ).toContain("Facebook can't mix photos and videos in one post.");
  });

  it("checks Instagram aspect ratios", () => {
    const tall = fakeMedia(config, { kind: "image", width: 1080, height: 1920 });
    expect(validateForPlatform(instagram, input(instagram, { media: [tall] }), config)[0]).toMatch(/between 4:5/);
    const ok = fakeMedia(config, { kind: "image", width: 1080, height: 1350 });
    expect(validateForPlatform(instagram, input(instagram, { media: [ok] }), config)).toEqual([]);
  });

  it("requires a public URL only where the platform downloads our media", () => {
    const local = testConfig({ publicBaseUrl: "http://localhost:3000" });
    const photo = fakeMedia(local, { kind: "image" });
    const video = fakeMedia(local, { kind: "video" });
    expect(validateForPlatform(instagram, input(instagram, { media: [photo] }), local)[0]).toMatch(/PUBLIC_BASE_URL/);
    expect(validateForPlatform(instagram, input(instagram, { media: [video] }), local)).toEqual([]); // reels upload directly
    expect(validateForPlatform(threads, input(threads, { media: [video] }), local)[0]).toMatch(/PUBLIC_BASE_URL/);
    expect(validateForPlatform(threads, input(threads, { text: "text only" }), local)).toEqual([]);
  });
});

describe("server", () => {
  let config: Config;
  let app: FastifyInstance;
  let cookie: string;

  beforeEach(async () => {
    clearBlueskySessions();
    config = testConfig();
    app = await buildApp({ config, dbFile: ":memory:", sleep: async () => {} });
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/api/login", payload: { password: "hunter22" } });
    cookie = String(res.headers["set-cookie"]).split(";")[0];
  });

  afterEach(async () => {
    await app.close();
  });

  const api = (method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as any, url: `/api${url}`, payload: payload as any, headers: { cookie } });

  function addBlueskyAccount(): string {
    const [id] = app.services.accounts.saveDrafts("bluesky", [
      {
        platform: "bluesky",
        externalId: "did:plc:me",
        name: "Me",
        username: "me.bsky.social",
        credentials: { identifier: "me", appPassword: "p", service: "https://bsky.social" },
      },
    ]);
    return id;
  }

  const blueskyRoutes = (createRecord: () => any) => [
    {
      method: "POST",
      match: "https://bsky.social/xrpc/com.atproto.server.createSession",
      reply: () => ({ json: { did: "did:plc:me", handle: "me.bsky.social", accessJwt: "JWT" } }),
    },
    { method: "POST", match: "https://bsky.social/xrpc/com.atproto.repo.createRecord", reply: createRecord },
  ];

  it("requires login for the API and serves the dashboard", async () => {
    expect((await app.inject({ url: "/api/accounts" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/login", payload: { password: "nope" } })).statusCode).toBe(401);
    expect((await api("GET", "/accounts")).statusCode).toBe(200);
    const bearer = await app.inject({ url: "/api/accounts", headers: { authorization: "Bearer api-token-123" } });
    expect(bearer.statusCode).toBe(200);
    const page = await app.inject({ url: "/" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Post Sync");
  });

  it("rate-limits password guessing", async () => {
    for (let i = 0; i < 5; i++) await app.inject({ method: "POST", url: "/api/login", payload: { password: "bad" } });
    const res = await app.inject({ method: "POST", url: "/api/login", payload: { password: "hunter22" } });
    expect(res.statusCode).toBe(429);
  });

  it("never exposes stored tokens", async () => {
    addBlueskyAccount();
    const res = await api("GET", "/accounts");
    expect(res.body).not.toContain("appPassword");
    expect(res.body).not.toContain('"p"');
    const raw = app.services.db.listAccounts()[0].credentials;
    expect(raw.startsWith("v1:")).toBe(true);
  });

  it("uploads media and serves it only at its signed URL", async () => {
    const boundary = "----test";
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      Buffer.alloc(2000, 1),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/api/media",
      payload,
      headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}` },
    });
    expect(res.statusCode).toBe(200);
    const media = res.json().media[0];
    expect(media).toMatchObject({ kind: "image", mime: "image/jpeg", size: 2000 });

    const file = await app.inject({ url: media.previewUrl });
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.length).toBe(2000);
    const tampered = media.previewUrl.replace(/\/media\/[^/]+\//, "/media/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/");
    expect((await app.inject({ url: tampered })).statusCode).toBe(404);
  });

  it("rejects unsupported uploads", async () => {
    const boundary = "----test";
    const payload = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.exe"\r\nContent-Type: application/octet-stream\r\n\r\nMZ\r\n--${boundary}--\r\n`,
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/media",
      payload,
      headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Unsupported file type/);
  });

  it("publishes a post in the background and records the link", async () => {
    const accountId = addBlueskyAccount();
    const { calls } = mockFetch(blueskyRoutes(() => ({ json: { uri: "at://did:plc:me/app.bsky.feed.post/3kz", cid: "c" } })));

    const created = await api("POST", "/posts", { text: "Hello everyone", targets: [{ accountId }] });
    expect(created.statusCode).toBe(201);
    await app.services.worker.idle();

    const post = (await api("GET", `/posts/${created.json().post.id}`)).json().post;
    expect(post.targets[0]).toMatchObject({
      status: "succeeded",
      remoteUrl: "https://bsky.app/profile/me.bsky.social/post/3kz",
      attempts: 1,
    });
    expect(json(calls[1]).record.text).toBe("Hello everyone");
  });

  it("uses per-platform caption overrides", async () => {
    const accountId = addBlueskyAccount();
    const { calls } = mockFetch(blueskyRoutes(() => ({ json: { uri: "at://x/app.bsky.feed.post/1" } })));
    await api("POST", "/posts", { text: "Long version", platformText: { bluesky: "Short version" }, targets: [{ accountId }] });
    await app.services.worker.idle();
    expect(json(calls[1]).record.text).toBe("Short version");
  });

  it("refuses posts that a selected platform can't take", async () => {
    const accountId = addBlueskyAccount();
    const res = await api("POST", "/posts", { text: "x".repeat(301), targets: [{ accountId }] });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues[0].errors[0]).toMatch(/Bluesky allows 300 characters/);
  });

  it("retries temporary failures later, and lets the user retry permanent ones", async () => {
    const accountId = addBlueskyAccount();
    // The login fails with a server error: nothing was posted, so the queue retries by itself.
    mockFetch([
      {
        method: "POST",
        match: "https://bsky.social/xrpc/com.atproto.server.createSession",
        reply: () => ({ status: 503, json: { error: "Unavailable", message: "try later" } }),
      },
    ]);
    const created = (await api("POST", "/posts", { text: "hi", targets: [{ accountId }] })).json().post;
    await app.services.worker.idle();

    let target = (await api("GET", `/posts/${created.id}`)).json().post.targets[0];
    expect(target.status).toBe("queued");
    expect(target.error).toMatch(/retrying in 1 min/);
    expect(target.runAt).toBeGreaterThan(Date.now() + 50_000);

    // Permanent failure: 400s are not retried automatically.
    app.services.db.raw.prepare("UPDATE post_targets SET run_at = 0").run();
    mockFetch(blueskyRoutes(() => ({ status: 400, json: { error: "InvalidRequest", message: "bad record" } })));
    app.services.worker.kick();
    await app.services.worker.idle();
    target = (await api("GET", `/posts/${created.id}`)).json().post.targets[0];
    expect(target.status).toBe("failed");
    expect(target.error).toMatch(/bad record/);

    // Manual retry succeeds.
    mockFetch(blueskyRoutes(() => ({ json: { uri: "at://x/app.bsky.feed.post/ok" } })));
    expect((await api("POST", `/targets/${target.id}/retry`)).statusCode).toBe(200);
    await app.services.worker.idle();
    target = (await api("GET", `/posts/${created.id}`)).json().post.targets[0];
    expect(target.status).toBe("succeeded");
  });

  it("never auto-retries a post whose final request had an unknown outcome", async () => {
    const accountId = addBlueskyAccount();
    mockFetch(blueskyRoutes(() => ({ status: 502, json: { error: "BadGateway", message: "upstream" } })));
    const created = (await api("POST", "/posts", { text: "hi", targets: [{ accountId }] })).json().post;
    await app.services.worker.idle();
    const target = (await api("GET", `/posts/${created.id}`)).json().post.targets[0];
    expect(target.status).toBe("failed");
    expect(target.error).toMatch(/Bluesky may have published this post.*Check Bluesky before retrying/);
  });

  it("waits as long as a rate limit asks before retrying", async () => {
    const accountId = addBlueskyAccount();
    mockFetch([
      {
        method: "POST",
        match: "https://bsky.social/xrpc/com.atproto.server.createSession",
        reply: () => ({ status: 429, json: { error: "RateLimitExceeded" }, headers: { "retry-after": "7200" } }),
      },
    ]);
    const created = (await api("POST", "/posts", { text: "hi", targets: [{ accountId }] })).json().post;
    await app.services.worker.idle();
    const target = (await api("GET", `/posts/${created.id}`)).json().post.targets[0];
    expect(target.status).toBe("queued");
    expect(target.runAt).toBeGreaterThan(Date.now() + 7100_000);
    expect(target.error).toMatch(/retrying in 2 h/);
  });

  it("flags accounts whose login was rejected", async () => {
    const accountId = addBlueskyAccount();
    mockFetch([
      {
        method: "POST",
        match: "https://bsky.social/xrpc/com.atproto.server.createSession",
        reply: () => ({ status: 401, json: { error: "AuthenticationRequired", message: "Invalid identifier or password" } }),
      },
    ]);
    await api("POST", "/posts", { text: "hi", targets: [{ accountId }] });
    await app.services.worker.idle();
    const account = (await api("GET", "/accounts")).json().accounts[0];
    expect(account.status).toBe("needs_reauth");
    const again = await api("POST", "/posts/validate", { text: "hi", targets: [{ accountId }] });
    expect(again.json().issues[0].errors[0]).toMatch(/Reconnect this account/);
  });

  it("tests an account's login without posting", async () => {
    const accountId = addBlueskyAccount();
    mockFetch(blueskyRoutes(() => ({ status: 500, json: {} })));
    const ok = (await api("POST", `/accounts/${accountId}/check`)).json();
    expect(ok).toEqual({ ok: true, detail: "Can post as @me.bsky.social." });

    clearBlueskySessions();
    mockFetch([
      {
        method: "POST",
        match: "https://bsky.social/xrpc/com.atproto.server.createSession",
        reply: () => ({ status: 401, json: { error: "AuthenticationRequired", message: "Invalid identifier or password" } }),
      },
    ]);
    const bad = (await api("POST", `/accounts/${accountId}/check`)).json();
    expect(bad).toMatchObject({ ok: false, needsReconnect: true });
    expect((await api("GET", "/accounts")).json().accounts[0].status).toBe("needs_reauth");
  });

  it("holds scheduled posts until their time and allows cancelling", async () => {
    const accountId = addBlueskyAccount();
    mockFetch([]);
    const at = new Date(Date.now() + 3600_000).toISOString();
    const post = (await api("POST", "/posts", { text: "later", targets: [{ accountId }], scheduledAt: at })).json().post;
    await app.services.worker.idle();
    const target = post.targets[0];
    expect(target.status).toBe("queued");
    expect((await api("POST", `/targets/${target.id}/cancel`)).statusCode).toBe(200);
    expect((await api("GET", `/posts/${post.id}`)).json().post.targets[0].status).toBe("cancelled");
  });

  it("supports posting to every account of a platform via the API", async () => {
    addBlueskyAccount();
    mockFetch(blueskyRoutes(() => ({ json: { uri: "at://x/app.bsky.feed.post/1" } })));
    const res = await app.inject({
      method: "POST",
      url: "/api/posts",
      payload: { text: "via API", platforms: ["bluesky"] },
      headers: { authorization: "Bearer api-token-123" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().post.targets).toHaveLength(1);
  });

  it("blocks cross-site writes made with the session cookie", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/posts",
      payload: { text: "x", platforms: ["bluesky"] },
      headers: { cookie, origin: "https://evil.example" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("connects an account through the OAuth flow", async () => {
    const start = await app.inject({ url: "/connect/linkedin", headers: { cookie } });
    expect(start.statusCode).toBe(302);
    const authUrl = new URL(start.headers.location as string);
    expect(authUrl.origin + authUrl.pathname).toBe("https://www.linkedin.com/oauth/v2/authorization");
    expect(authUrl.searchParams.get("redirect_uri")).toBe("https://posts.example.com/oauth/linkedin/callback");
    expect(authUrl.searchParams.get("scope")).toBe("openid profile w_member_social");
    const state = authUrl.searchParams.get("state")!;

    const { calls } = mockFetch([
      {
        method: "POST",
        match: "https://www.linkedin.com/oauth/v2/accessToken",
        reply: () => ({ json: { access_token: "LI_TOKEN", expires_in: 5184000 } }),
      },
      { method: "GET", match: "https://api.linkedin.com/v2/userinfo", reply: () => ({ json: { sub: "abc123", name: "Tenzin" } }) },
    ]);
    const cb = await app.inject({ url: `/oauth/linkedin/callback?code=CODE&state=${state}` });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toContain("#accounts?connected=LinkedIn&count=1");
    expect(Object.fromEntries(calls[0].body as URLSearchParams)).toMatchObject({ code: "CODE", grant_type: "authorization_code" });

    const accounts = (await api("GET", "/accounts")).json().accounts;
    expect(accounts[0]).toMatchObject({ platform: "linkedin", name: "Tenzin", status: "active" });

    // The state is single-use.
    const replay = await app.inject({ url: `/oauth/linkedin/callback?code=CODE&state=${state}` });
    expect(replay.headers.location).toContain("error=");
  });

  it("uses PKCE for X", async () => {
    const start = await app.inject({ url: "/connect/x", headers: { cookie } });
    const authUrl = new URL(start.headers.location as string);
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
  });

  it("refreshes expired tokens before publishing", async () => {
    const [accountId] = app.services.accounts.saveDrafts("x", [
      {
        platform: "x",
        externalId: "42",
        name: "Me",
        username: "me",
        credentials: { accessToken: "OLD", refreshToken: "R1" },
        expiresAt: Date.now() - 1000,
      },
    ]);
    const { calls } = mockFetch([
      {
        method: "POST",
        match: "https://api.x.com/2/oauth2/token",
        reply: () => ({ json: { access_token: "NEW", refresh_token: "R2", expires_in: 7200 } }),
      },
      { method: "POST", match: "https://api.x.com/2/tweets", reply: () => ({ status: 201, json: { data: { id: "1" } } }) },
    ]);
    await api("POST", "/posts", { text: "fresh", targets: [{ accountId }] });
    await app.services.worker.idle();
    expect(calls[1].headers.get("authorization")).toBe("Bearer NEW");
    expect(calls[0].headers.get("authorization")).toMatch(/^Basic /);
    const creds = await app.services.accounts.credentials(accountId);
    expect(creds).toEqual({ accessToken: "NEW", refreshToken: "R2" });
  });
});

describe.runIf(await hasFfmpeg())("image conversion", () => {
  it("converts PNGs to JPEG and shrinks them under a size limit", async () => {
    const config = testConfig();
    const app = await buildApp({ config, dbFile: ":memory:", startWorker: false });
    const src = path.join(config.mediaDir, "big.png");
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=3000x2000", "-frames:v", "1", src]);
    const media = {
      id: "big",
      filename: "big.png",
      file: "big.png",
      path: src,
      mime: "image/png",
      kind: "image" as const,
      size: fs.statSync(src).size,
      width: 3000,
      height: 2000,
      duration: null,
    };
    const jpeg = await app.services.media.jpegVariant(media, { maxBytes: 300_000, maxDimension: 2000 });
    expect(jpeg.mime).toBe("image/jpeg");
    expect(jpeg.size).toBeLessThanOrEqual(300_000);
    expect(Math.max(jpeg.width!, jpeg.height!)).toBeLessThanOrEqual(2000);
    expect(app.services.media.verifyPublicUrl(new URL(app.services.media.publicUrl(jpeg.file)).pathname.split("/")[2], jpeg.file)).toBe(true);
    await app.close();
  });
});
