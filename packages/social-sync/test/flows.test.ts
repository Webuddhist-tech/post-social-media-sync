/**
 * End-to-end flows through the engine and its HTTP handler: connecting accounts, uploading media, publishing,
 * retries, scheduling, events and keeping owners apart. Ported from the standalone app's server tests.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHandler,
  createPostSync,
  type PlatformKeys,
  type PostSync,
  type PostSyncEventName,
  type PostSyncEvents,
  type PostSyncHandler,
  type PostSyncOptions,
  type Storage,
} from "../src/index.js";
import { hasFfmpeg } from "../src/media.js";
import { clearBlueskySessions } from "../src/platforms/bluesky.js";
import { facebook } from "../src/platforms/facebook.js";
import { instagram } from "../src/platforms/instagram.js";
import { threads } from "../src/platforms/threads.js";
import { tiktokPlatform } from "../src/platforms/tiktok.js";
import type { Platform, PublishInput } from "../src/platforms/types.js";
import { x } from "../src/platforms/x.js";
import { youtube } from "../src/platforms/youtube.js";
import { validateForPlatform, withDefaults } from "../src/posts.js";
import { sqliteStorage } from "../src/storage/sqlite.js";
import { fakeMedia, form, json, mockFetch, tempDir, testConfig, TEST_SECRET, type MockCall, type Route } from "./helpers.js";

const BASE = "https://posts.example.com";
const OWNER = "owner-1";
const OTHER = "owner-2";
const BSKY = "https://bsky.social/xrpc";
const XAPI = "https://api.x.com/2";
const GRAPH = "https://graph.facebook.com/v26.0";

const PLATFORM_KEYS: PlatformKeys = {
  meta: { appId: "meta-app", appSecret: "meta-secret" },
  threads: { appId: "th-app", appSecret: "th-secret" },
  tiktok: { clientKey: "tt-key", clientSecret: "tt-secret" },
  linkedin: { clientId: "li-id", clientSecret: "li-secret" },
  google: { clientId: "g-id", clientSecret: "g-secret" },
  x: { clientId: "x-id", clientSecret: "x-secret" },
};

// ---- engine, clock and HTTP helpers --------------------------------------------------------------

const engines: PostSync[] = [];

async function makeEngine(overrides: Partial<PostSyncOptions> = {}): Promise<PostSync> {
  const engine = await createPostSync({
    secret: TEST_SECRET,
    publicUrl: BASE,
    storage: sqliteStorage(":memory:"),
    mediaDir: tempDir(),
    platforms: PLATFORM_KEYS,
    logger: false,
    worker: { autoStart: false },
    sleep: async () => {},
    ...overrides,
  });
  engines.push(engine);
  return engine;
}

const realNow = Date.now;
let clockOffset = 0;

/** Moves Date.now forward, as if that much time had passed (undone after each test). */
function advanceClock(ms: number): void {
  clockOffset += ms;
  vi.spyOn(Date, "now").mockImplementation(() => realNow.call(Date) + clockOffset);
}

afterEach(async () => {
  clockOffset = 0;
  await Promise.all(engines.splice(0).map((e) => e.close()));
});

let storage: Storage;
let sync: PostSync;
let handler: PostSyncHandler;

interface Reply {
  status: number;
  headers: Headers;
  raw: Buffer;
  body: string;
  json(): any;
}

/** Sends a web Request through the handler (like the old `app.inject`). `owner` is who is logged in; omit it for none. */
async function inject(opts: { method?: string; url: string; payload?: unknown; headers?: Record<string, string>; owner?: string }): Promise<Reply> {
  const headers = new Headers(opts.headers);
  if (opts.owner) headers.set("x-owner", opts.owner);
  let body: RequestInit["body"];
  if (opts.payload instanceof FormData) body = opts.payload;
  else if (opts.payload !== undefined) {
    body = JSON.stringify(opts.payload);
    headers.set("content-type", "application/json");
  }
  const res = await handler.fetch(new Request(new URL(opts.url, BASE), { method: opts.method ?? "GET", headers, body }));
  const raw = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, raw, body: raw.toString("utf8"), json: () => JSON.parse(raw.toString("utf8")) };
}

const api = (method: string, url: string, payload?: unknown, owner = OWNER) => inject({ method, url, payload, owner });

const targetOf = async (postId: string, owner = OWNER) => (await api("GET", `/posts/${postId}`, undefined, owner)).json().post.targets[0];

function upload(owner: string, filename: string, type: string, data: Uint8Array<ArrayBuffer>) {
  const body = new FormData();
  body.append("file", new Blob([data], { type }), filename);
  return api("POST", "/media", body, owner);
}

/** Collects the payloads of one event. */
function collect<E extends PostSyncEventName>(event: E, engine: PostSync = sync): Array<PostSyncEvents[E]> {
  const seen: Array<PostSyncEvents[E]> = [];
  engine.on(event, (payload) => seen.push(payload));
  return seen;
}

// ---- platform mocks -------------------------------------------------------------------------------

/** Bluesky login: the identifier is the handle, the DID is derived from it. */
const blueskyLogin: Route = {
  method: "POST",
  match: `${BSKY}/com.atproto.server.createSession`,
  reply: (call) => {
    const handle = String(json(call).identifier);
    return { json: { did: `did:plc:${handle.split(".")[0]}`, handle, accessJwt: "JWT" } };
  },
};
const blueskyProfile: Route = { method: "GET", match: `${BSKY}/app.bsky.actor.getProfile`, reply: () => ({ json: { displayName: "Me" } }) };
const blueskyLoginFails = (status: number, body: unknown, headers: Record<string, string> = {}): Route => ({
  method: "POST",
  match: `${BSKY}/com.atproto.server.createSession`,
  reply: () => ({ status, json: body, headers }),
});
const blueskyRoutes = (createRecord: Route["reply"]): Route[] => [
  blueskyLogin,
  { method: "POST", match: `${BSKY}/com.atproto.repo.createRecord`, reply: createRecord },
];
const published = () => ({ json: { uri: "at://did:plc:me/app.bsky.feed.post/3kz", cid: "c" } });
const rejectedLogin = { error: "AuthenticationRequired", message: "Invalid identifier or password" };

/** The text of every Bluesky record that was created. */
const postedTexts = (calls: MockCall[]) => calls.filter((c) => c.url.pathname.endsWith("createRecord")).map((c) => json(c).record.text);

/** Connects a Bluesky account (handle + app password) and returns its id. */
async function addBlueskyAccount(owner = OWNER, handle = "me.bsky.social", engine: PostSync = sync): Promise<string> {
  mockFetch([blueskyLogin, blueskyProfile]);
  const [account] = await engine.connect.withCredentials(owner, "bluesky", { identifier: handle, appPassword: "app-pass-1234" });
  return account.id;
}

/** The OAuth binding cookie a /connect response gave the browser, as a Cookie header for its callback. */
const bindingCookie = (start: Reply) => ({ cookie: start.headers.get("set-cookie")!.split(";")[0] });

/** Connects an X account through OAuth (its token lives 2 hours). Returns the account id and the exchange's requests. */
async function connectX(owner = OWNER) {
  const start = await api("POST", "/connect/x", {}, owner);
  expect(start.status).toBe(200);
  const authUrl = new URL(start.json().url);
  const { calls } = mockFetch([
    { method: "POST", match: `${XAPI}/oauth2/token`, reply: () => ({ json: { access_token: "OLD", refresh_token: "R1", expires_in: 7200 } }) },
    { method: "GET", match: `${XAPI}/users/me`, reply: () => ({ json: { data: { id: "42", name: "Me", username: "me" } } }) },
  ]);
  const cb = await inject({ url: `/oauth/x/callback?code=CODE&state=${authUrl.searchParams.get("state")}`, headers: bindingCookie(start) });
  expect(new URL(cb.headers.get("location")!).searchParams.get("postsync")).toBe("connected");
  const account = (await sync.accounts.list(owner)).find((a) => a.platform === "x")!;
  return { accountId: account.id, authUrl, calls };
}

function metaRoutes(): Route[] {
  return [
    {
      method: "GET",
      match: `${GRAPH}/oauth/access_token`,
      reply: (call) => ({ json: { access_token: call.url.searchParams.has("fb_exchange_token") ? "LONG_TOKEN" : "SHORT_TOKEN" } }),
    },
    {
      method: "GET",
      match: `${GRAPH}/me/permissions`,
      reply: () => ({
        json: {
          data: ["pages_show_list", "pages_manage_posts", "instagram_basic", "instagram_content_publish"].map((permission) => ({ permission, status: "granted" })),
        },
      }),
    },
    {
      method: "GET",
      match: `${GRAPH}/me/accounts`,
      reply: () => ({
        json: {
          data: [
            {
              id: "page-1",
              name: "Lotus Studio",
              access_token: "PAGE_TOKEN",
              tasks: ["CREATE_CONTENT"],
              instagram_business_account: { id: "ig-1", username: "lotus" },
            },
          ],
        },
      }),
    },
  ];
}

// ---- validation -------------------------------------------------------------------------------------

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
    const unreachable = /its public URL \(http:\/\/localhost:3000\) isn't reachable from the internet/;
    expect(validateForPlatform(instagram, input(instagram, { media: [photo] }), local)[0]).toMatch(unreachable);
    expect(validateForPlatform(instagram, input(instagram, { media: [video] }), local)).toEqual([]); // reels upload directly
    expect(validateForPlatform(threads, input(threads, { media: [video] }), local)[0]).toMatch(unreachable);
    expect(validateForPlatform(threads, input(threads, { text: "text only" }), local)).toEqual([]);
  });

  it("names the engine's own publicUrl when it isn't reachable", async () => {
    const engine = await makeEngine({ publicUrl: "http://localhost:3000/api/" });
    expect((await engine.describe()).publicMediaReachable).toBe(false);
    const video = fakeMedia(engine.config, { kind: "video" });
    expect(validateForPlatform(threads, input(threads, { media: [video] }), engine.config)[0]).toMatch(
      /its public URL \(http:\/\/localhost:3000\/api\) isn't reachable/,
    );
  });
});

// ---- flows through the HTTP handler ------------------------------------------------------------------

describe("flows", () => {
  beforeEach(async () => {
    clearBlueskySessions();
    storage = sqliteStorage(":memory:");
    sync = await makeEngine({ storage });
    // The host app decides who is calling; here a header names the owner so tests can switch between two.
    handler = createHandler(sync, { authenticate: (request) => request.headers.get("x-owner") });
  });

  it("never exposes stored tokens", async () => {
    mockFetch([blueskyLogin, blueskyProfile]);
    const connected = await api("POST", "/connect/bluesky/credentials", {
      fields: { identifier: "me.bsky.social", appPassword: "secret-app-pass" },
    });
    expect(connected.status).toBe(201);
    const { id } = connected.json().accounts[0];
    for (const res of [connected, await api("GET", "/accounts"), await api("GET", `/accounts/${id}`)]) {
      expect(res.status).toBeLessThan(300);
      expect(res.body).not.toContain("appPassword");
      expect(res.body).not.toContain("secret-app-pass");
      expect(res.body).not.toContain("credentials");
    }
    const [row] = await storage.listAccounts(OWNER);
    expect(row.credentials.startsWith("v1:")).toBe(true);
    expect(row.credentials).not.toContain("secret-app-pass");
  });

  it("uploads media and serves it only at its signed URL", async () => {
    const bytes = Buffer.from(Array.from({ length: 2000 }, (_, i) => i % 251));
    const res = await upload(OWNER, "a.jpg", "image/jpeg", bytes);
    expect(res.status).toBe(201);
    const media = res.json().media[0];
    expect(media).toMatchObject({ kind: "image", mime: "image/jpeg", size: 2000, ownerId: OWNER, filename: "a.jpg" });
    expect(media.url).toMatch(/^https:\/\/posts\.example\.com\/media\/[\w-]{32}\/[^/]+\.jpg$/);

    // The signed URL needs no login: platforms download from it.
    const file = await inject({ url: media.url });
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/jpeg");
    expect(file.raw.equals(bytes)).toBe(true);

    // Range requests (video players and some platforms fetch in pieces).
    const part = await inject({ url: media.url, headers: { range: "bytes=100-199" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 100-199/2000");
    expect(part.raw.equals(bytes.subarray(100, 200))).toBe(true);
    const tail = await inject({ url: media.url, headers: { range: "bytes=-50" } });
    expect(tail.status).toBe(206);
    expect(tail.raw.equals(bytes.subarray(1950))).toBe(true);
    const rest = await inject({ url: media.url, headers: { range: "bytes=1990-" } });
    expect(rest.headers.get("content-range")).toBe("bytes 1990-1999/2000");
    expect(rest.raw.length).toBe(10);
    expect((await inject({ url: media.url, headers: { range: "bytes=5000-" } })).status).toBe(416);
    const head = await inject({ method: "HEAD", url: media.url });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("2000");
    expect(head.raw.length).toBe(0);

    // A wrong signature, or a valid one for another file, finds nothing.
    const tampered = media.url.replace(/\/media\/[^/]+\//, "/media/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/");
    expect((await inject({ url: tampered })).status).toBe(404);
    const other = (await upload(OWNER, "b.jpg", "image/jpeg", Buffer.alloc(10, 2))).json().media[0];
    const swapped = media.url.replace(/[^/]+$/, other.url.split("/").pop());
    expect((await inject({ url: swapped })).status).toBe(404);

    // Only its owner can look it up or delete it; once deleted, the URL stops working.
    expect((await api("GET", `/media/${media.id}`)).json().media.id).toBe(media.id);
    expect((await api("GET", `/media/${media.id}`, undefined, OTHER)).status).toBe(404);
    expect((await api("DELETE", `/media/${media.id}`, undefined, OTHER)).status).toBe(404);
    expect((await api("DELETE", `/media/${media.id}`)).status).toBe(200);
    expect((await inject({ url: media.url })).status).toBe(404);
    expect((await api("GET", `/media/${media.id}`)).status).toBe(404);
  });

  it("rejects unsupported uploads", async () => {
    const res = await upload(OWNER, "a.exe", "application/octet-stream", Buffer.from("MZ"));
    expect(res.status).toBe(400);
    expect(res.json().error).toMatch(/Unsupported file type/);
    expect((await api("POST", "/media", { not: "multipart" })).status).toBe(400);
  });

  it("publishes a post in the background and records the link", async () => {
    const accountId = await addBlueskyAccount();
    const { calls } = mockFetch(blueskyRoutes(published));

    const created = await api("POST", "/posts", { text: "Hello everyone", targets: [{ accountId }] });
    expect(created.status).toBe(201);
    const { post } = created.json();
    expect(post.targets[0]).toMatchObject({ status: "queued", attempts: 0, accountId, ownerId: OWNER });
    expect(await sync.worker.runDue()).toEqual({ processed: 1 });

    expect(await targetOf(post.id)).toMatchObject({
      status: "succeeded",
      remoteUrl: "https://bsky.app/profile/me.bsky.social/post/3kz",
      attempts: 1,
      error: null,
    });
    expect(postedTexts(calls)).toEqual(["Hello everyone"]);
    expect((await api("GET", "/posts")).json().posts.map((p: any) => p.id)).toEqual([post.id]);
  });

  it("uses per-platform caption overrides", async () => {
    const accountId = await addBlueskyAccount();
    const { calls } = mockFetch(blueskyRoutes(published));
    const post = (await api("POST", "/posts", { text: "Long version", platformText: { bluesky: "Short version" }, targets: [{ accountId }] })).json()
      .post;
    expect(post.text).toBe("Long version");
    expect(post.targets[0].textOverride).toBe("Short version");
    // A per-account caption wins over the per-platform one.
    await api("POST", "/posts", { text: "Long", platformText: { bluesky: "Short" }, targets: [{ accountId, text: "Just here" }] });
    await sync.worker.runDue();
    expect(postedTexts(calls).sort()).toEqual(["Just here", "Short version"]);
  });

  it("refuses posts that a selected platform can't take", async () => {
    const accountId = await addBlueskyAccount();
    const res = await api("POST", "/posts", { text: "x".repeat(301), targets: [{ accountId }] });
    expect(res.status).toBe(400);
    expect(res.json().issues[0].errors[0]).toMatch(/Bluesky allows 300 characters/);
    expect((await api("GET", "/posts")).json().posts).toEqual([]);

    const check = await api("POST", "/posts/validate", { text: "x".repeat(301), targets: [{ accountId }] });
    expect(check.status).toBe(200);
    expect(check.json().issues).toEqual([
      { accountId, accountName: "Me", platform: "bluesky", length: 301, errors: [expect.stringMatching(/Bluesky allows 300 characters/)] },
    ]);
  });

  it("retries temporary failures later, and lets the user retry permanent ones", async () => {
    const accountId = await addBlueskyAccount();
    // The login fails with a server error: nothing was posted, so the queue retries by itself.
    mockFetch([blueskyLoginFails(503, { error: "Unavailable", message: "try later" })]);
    const created = (await api("POST", "/posts", { text: "hi", targets: [{ accountId }] })).json().post;
    await sync.worker.runDue();

    let target = await targetOf(created.id);
    expect(target.status).toBe("queued");
    expect(target.error).toMatch(/retrying in 1 min/);
    expect(target.runAt).toBeGreaterThan(Date.now() + 50_000);
    expect((await sync.worker.runDue()).processed).toBe(0); // not due yet

    // A minute later it runs again and fails for good: 400s are not retried automatically.
    advanceClock(2 * 60_000);
    mockFetch(blueskyRoutes(() => ({ status: 400, json: { error: "InvalidRequest", message: "bad record" } })));
    expect((await sync.worker.runDue()).processed).toBe(1);
    target = await targetOf(created.id);
    expect(target).toMatchObject({ status: "failed", attempts: 2 });
    expect(target.error).toMatch(/bad record/);

    // Only the owner can retry it, and then it succeeds.
    mockFetch(blueskyRoutes(published));
    expect((await api("POST", `/targets/${target.id}/retry`, undefined, OTHER)).status).toBe(409);
    expect((await api("POST", `/targets/${target.id}/retry`)).status).toBe(200);
    await sync.worker.runDue();
    target = await targetOf(created.id);
    expect(target).toMatchObject({ status: "succeeded", attempts: 1, error: null });
    // Succeeded jobs can't be retried (that would post twice).
    expect((await api("POST", `/targets/${target.id}/retry`)).status).toBe(409);
  });

  it("never auto-retries a post whose final request had an unknown outcome", async () => {
    const accountId = await addBlueskyAccount();
    mockFetch(blueskyRoutes(() => ({ status: 502, json: { error: "BadGateway", message: "upstream" } })));
    const created = (await api("POST", "/posts", { text: "hi", targets: [{ accountId }] })).json().post;
    await sync.worker.runDue();
    const target = await targetOf(created.id);
    expect(target.status).toBe("failed");
    expect(target.error).toMatch(/Bluesky may have published this post.*Check Bluesky before retrying/);
    advanceClock(2 * 3600_000);
    expect((await sync.worker.runDue()).processed).toBe(0);
  });

  it("waits as long as a rate limit asks before retrying", async () => {
    const accountId = await addBlueskyAccount();
    mockFetch([blueskyLoginFails(429, { error: "RateLimitExceeded" }, { "retry-after": "7200" })]);
    const created = (await api("POST", "/posts", { text: "hi", targets: [{ accountId }] })).json().post;
    await sync.worker.runDue();
    const target = await targetOf(created.id);
    expect(target.status).toBe("queued");
    expect(target.runAt).toBeGreaterThan(Date.now() + 7100_000);
    expect(target.error).toMatch(/retrying in 2 h/);
    advanceClock(3600_000); // an hour later it's still waiting
    expect((await sync.worker.runDue()).processed).toBe(0);
  });

  it("flags accounts whose login was rejected", async () => {
    const accountId = await addBlueskyAccount();
    mockFetch([blueskyLoginFails(401, rejectedLogin)]);
    const created = (await api("POST", "/posts", { text: "hi", targets: [{ accountId }] })).json().post;
    await sync.worker.runDue();
    expect((await targetOf(created.id)).status).toBe("failed");
    const account = (await api("GET", "/accounts")).json().accounts[0];
    expect(account.status).toBe("needs_reauth");
    expect(account.statusMessage).toMatch(/Invalid identifier or password/);
    const again = await api("POST", "/posts/validate", { text: "hi", targets: [{ accountId }] });
    expect(again.json().issues[0].errors[0]).toMatch(/Reconnect this account/);
    // "Every Bluesky account" skips accounts that need reconnecting.
    expect((await api("POST", "/posts", { text: "hi", platforms: ["bluesky"] })).json().error).toMatch(/Choose at least one account/);
  });

  it("tests an account's login without posting", async () => {
    const accountId = await addBlueskyAccount();
    const getSession: Route = {
      method: "GET",
      match: `${BSKY}/com.atproto.server.getSession`,
      reply: () => ({ json: { handle: "me.bsky.social", active: true } }),
    };
    const { calls } = mockFetch([blueskyLogin, getSession]);
    expect((await api("POST", `/accounts/${accountId}/check`)).json()).toEqual({ ok: true, detail: "Can post as @me.bsky.social." });
    expect(calls.some((c) => c.url.pathname.endsWith("createRecord"))).toBe(false);
    expect((await api("POST", `/accounts/${accountId}/check`, undefined, OTHER)).status).toBe(404);

    clearBlueskySessions();
    mockFetch([blueskyLoginFails(401, rejectedLogin)]);
    const bad = (await api("POST", `/accounts/${accountId}/check`)).json();
    expect(bad).toMatchObject({ ok: false, needsReconnect: true });
    expect(bad.error).toMatch(/Invalid identifier or password/);
    expect((await api("GET", "/accounts")).json().accounts[0].status).toBe("needs_reauth");

    // Once the login works again, a check clears the flag.
    mockFetch([blueskyLogin, getSession]);
    expect((await api("POST", `/accounts/${accountId}/check`)).json().ok).toBe(true);
    expect((await api("GET", "/accounts")).json().accounts[0]).toMatchObject({ status: "active", statusMessage: null });
  });

  it("retries later when refreshing a login fails temporarily (nothing was posted)", async () => {
    const { accountId } = await connectX();
    advanceClock(3 * 3600_000); // the 2-hour token has expired
    const { calls } = mockFetch([
      { method: "POST", match: `${XAPI}/oauth2/token`, reply: () => ({ status: 503, json: { title: "Service Unavailable", detail: "busy" } }) },
    ]);
    const post = (await api("POST", "/posts", { text: "later", targets: [{ accountId }] })).json().post;
    await sync.worker.runDue();
    const target = await targetOf(post.id);
    expect(target.status).toBe("queued");
    expect(target.error).toMatch(/Couldn't refresh the login/);
    expect(calls.some((c) => c.url.pathname === "/2/tweets")).toBe(false);
    expect((await api("GET", `/accounts/${accountId}`)).json().account.status).toBe("active");
  });

  it("refreshes expired tokens before publishing", async () => {
    const { accountId } = await connectX();
    advanceClock(3 * 3600_000);
    const { calls } = mockFetch([
      { method: "POST", match: `${XAPI}/oauth2/token`, reply: () => ({ json: { access_token: "NEW", refresh_token: "R2", expires_in: 7200 } }) },
      { method: "POST", match: `${XAPI}/tweets`, reply: () => ({ status: 201, json: { data: { id: "1" } } }) },
    ]);
    const post = (await api("POST", "/posts", { text: "fresh", targets: [{ accountId }] })).json().post;
    await sync.worker.runDue();
    expect(calls.map((c) => c.url.pathname)).toEqual(["/2/oauth2/token", "/2/tweets"]);
    expect(calls[0].headers.get("authorization")).toMatch(/^Basic /);
    expect(form(calls[0])).toMatchObject({ grant_type: "refresh_token", refresh_token: "R1" });
    expect(calls[1].headers.get("authorization")).toBe("Bearer NEW");
    expect(await targetOf(post.id)).toMatchObject({ status: "succeeded", remoteUrl: "https://x.com/me/status/1" });

    // The new tokens were saved: the next post uses them without refreshing again.
    expect((await api("GET", `/accounts/${accountId}`)).json().account.expiresAt).toBeGreaterThan(Date.now() + 3600_000);
    const next = mockFetch([{ method: "POST", match: `${XAPI}/tweets`, reply: () => ({ status: 201, json: { data: { id: "2" } } }) }]);
    await api("POST", "/posts", { text: "again", targets: [{ accountId }] });
    await sync.worker.runDue();
    expect(next.calls.map((c) => c.url.pathname)).toEqual(["/2/tweets"]);
    expect(next.calls[0].headers.get("authorization")).toBe("Bearer NEW");
  });

  it("holds scheduled posts until their time and allows cancelling", async () => {
    const accountId = await addBlueskyAccount();
    const { calls } = mockFetch(blueskyRoutes(published));
    const cancelled = collect("target.cancelled");
    const at = Date.now() + 3600_000;
    const schedule = async (text: string) =>
      (await api("POST", "/posts", { text, targets: [{ accountId }], scheduledAt: new Date(at).toISOString() })).json().post;
    const keep = await schedule("on time");
    const drop = await schedule("never");
    expect(keep.scheduledAt).toBe(at);
    expect((await sync.worker.runDue()).processed).toBe(0);
    const target = await targetOf(drop.id);
    expect(target).toMatchObject({ status: "queued", runAt: at });

    expect((await api("POST", `/targets/${target.id}/cancel`, undefined, OTHER)).status).toBe(409);
    expect((await api("POST", `/targets/${target.id}/cancel`)).status).toBe(200);
    expect((await targetOf(drop.id)).status).toBe("cancelled");
    expect(cancelled.map((e) => e.target.id)).toEqual([target.id]);
    expect((await api("POST", `/targets/${target.id}/cancel`)).status).toBe(409);

    advanceClock(2 * 3600_000);
    expect((await sync.worker.runDue()).processed).toBe(1);
    expect((await targetOf(keep.id)).status).toBe("succeeded");
    expect((await targetOf(drop.id)).status).toBe("cancelled");
    expect(postedTexts(calls)).toEqual(["on time"]);
  });

  it("posts to every active account of a platform via `platforms`", async () => {
    const first = await addBlueskyAccount(OWNER, "me.bsky.social");
    const second = await addBlueskyAccount(OWNER, "studio.bsky.social");
    await addBlueskyAccount(OTHER, "them.bsky.social");
    const { calls } = mockFetch(blueskyRoutes(published));
    const res = await api("POST", "/posts", { text: "via API", platforms: ["bluesky"] });
    expect(res.status).toBe(201);
    expect(res.json().post.targets.map((t: any) => t.accountId).sort()).toEqual([first, second].sort());
    expect((await sync.worker.runDue()).processed).toBe(2);
    expect(postedTexts(calls)).toEqual(["via API", "via API"]);
    expect((await api("POST", "/posts", { text: "x", platforms: ["myspace"] })).json().error).toMatch(/Unknown platform/);
  });
});

// ---- connecting accounts --------------------------------------------------------------------------------

describe("connecting accounts", () => {
  beforeEach(async () => {
    storage = sqliteStorage(":memory:");
    sync = await makeEngine({ storage });
    handler = createHandler(sync, { authenticate: (request) => request.headers.get("x-owner") });
  });

  it("connects through the OAuth flow and binds the accounts to the owner who started it", async () => {
    const start = await api("POST", "/connect/meta", { returnTo: "/settings" });
    expect(start.status).toBe(200);
    const authUrl = new URL(start.json().url);
    expect(authUrl.origin + authUrl.pathname).toBe("https://www.facebook.com/v26.0/dialog/oauth");
    expect(authUrl.searchParams.get("client_id")).toBe("meta-app");
    expect(authUrl.searchParams.get("redirect_uri")).toBe("https://posts.example.com/oauth/meta/callback");
    const state = authUrl.searchParams.get("state")!;
    expect(state).toBeTruthy();

    // The platform sends the browser back; the callback needs no login: the state says whose accounts these are, and
    // the binding cookie proves this is the browser that started the login.
    const { calls } = mockFetch(metaRoutes());
    const cb = await inject({ url: `/oauth/meta/callback?code=CODE&state=${state}`, headers: bindingCookie(start) });
    expect(cb.status).toBe(302);
    const back = new URL(cb.headers.get("location")!);
    expect(back.origin + back.pathname).toBe("https://posts.example.com/settings");
    expect(Object.fromEntries(back.searchParams)).toEqual({ postsync: "connected", connector: "Facebook & Instagram", count: "2" });
    expect(Object.fromEntries(calls[0].url.searchParams)).toMatchObject({
      code: "CODE",
      redirect_uri: "https://posts.example.com/oauth/meta/callback",
      client_secret: "meta-secret",
    });

    const accounts = (await api("GET", "/accounts")).json().accounts;
    expect(accounts.map((a: any) => [a.platform, a.name, a.status, a.ownerId])).toEqual([
      ["facebook", "Lotus Studio", "active", OWNER],
      ["instagram", "lotus", "active", OWNER],
    ]);
    expect((await api("GET", "/accounts", undefined, OTHER)).json().accounts).toEqual([]);
    const stored = await storage.listAccounts(OWNER);
    expect(stored.every((a) => a.credentials.startsWith("v1:") && !a.credentials.includes("PAGE_TOKEN"))).toBe(true);

    // The state is single-use.
    const replay = await inject({ url: `/oauth/meta/callback?code=CODE&state=${state}` });
    expect(replay.status).toBe(302);
    const replayed = new URL(replay.headers.get("location")!);
    expect(replayed.origin + replayed.pathname).toBe("https://posts.example.com/");
    expect(replayed.searchParams.get("postsync")).toBe("error");
    expect(replayed.searchParams.get("error")).toMatch(/expired or was already used/);
    expect(await storage.listAccounts(OWNER)).toHaveLength(2);
  });

  it("sends the browser back with an error when the login fails", async () => {
    // Declined on the platform's login page.
    const start = (await api("POST", "/connect/meta", { returnTo: "https://posts.example.com/app" })).json();
    let state = new URL(start.url).searchParams.get("state");
    const { fn } = mockFetch(metaRoutes());
    let cb = await inject({ url: `/oauth/meta/callback?error=access_denied&error_description=Permissions+error&state=${state}` });
    let back = new URL(cb.headers.get("location")!);
    expect(back.origin + back.pathname).toBe("https://posts.example.com/app");
    expect(back.searchParams.get("postsync")).toBe("error");
    expect(back.searchParams.get("connector")).toBe("Facebook & Instagram");
    expect(back.searchParams.get("error")).toMatch(/login was cancelled or failed: Permissions error/);
    expect(fn).not.toHaveBeenCalled();

    // The platform refuses the code.
    const started = await api("POST", "/connect/meta", {});
    state = new URL(started.json().url).searchParams.get("state");
    mockFetch([
      { match: `${GRAPH}/oauth/access_token`, reply: () => ({ status: 400, json: { error: { message: "Invalid verification code", code: 100 } } }) },
    ]);
    cb = await inject({ url: `/oauth/meta/callback?code=BAD&state=${state}`, headers: bindingCookie(started) });
    back = new URL(cb.headers.get("location")!);
    expect(back.searchParams.get("postsync")).toBe("error");
    expect(back.searchParams.get("error")).toMatch(/Connecting Facebook & Instagram failed: .*Invalid verification code/);

    // An unknown state never creates accounts.
    cb = await inject({ url: "/oauth/meta/callback?code=CODE&state=made-up" });
    expect(new URL(cb.headers.get("location")!).searchParams.get("postsync")).toBe("error");
    expect((await api("GET", "/accounts")).json().accounts).toEqual([]);

    // Bad starts are refused before leaving the app.
    expect((await api("POST", "/connect/meta", { returnTo: "https://evil.example/x" })).json().error).toMatch(/isn't allowed/);
    expect((await api("POST", "/connect/nope", {})).status).toBe(400);
    expect((await inject({ method: "POST", url: "/connect/meta", payload: {} })).status).toBe(401);
  });

  it("starts a login by browser navigation and exchanges the code (LinkedIn)", async () => {
    const start = await api("GET", "/connect/linkedin");
    expect(start.status).toBe(302);
    const authUrl = new URL(start.headers.get("location")!);
    expect(authUrl.origin + authUrl.pathname).toBe("https://www.linkedin.com/oauth/v2/authorization");
    expect(authUrl.searchParams.get("redirect_uri")).toBe("https://posts.example.com/oauth/linkedin/callback");
    expect(authUrl.searchParams.get("scope")).toBe("openid profile w_member_social");
    const state = authUrl.searchParams.get("state")!;

    const { calls } = mockFetch([
      { method: "POST", match: "https://www.linkedin.com/oauth/v2/accessToken", reply: () => ({ json: { access_token: "LI_TOKEN", expires_in: 5184000 } }) },
      { method: "GET", match: "https://api.linkedin.com/v2/userinfo", reply: () => ({ json: { sub: "abc123", name: "Tenzin" } }) },
    ]);
    const cb = await inject({ url: `/oauth/linkedin/callback?code=CODE&state=${state}`, headers: bindingCookie(start) });
    expect(cb.status).toBe(302);
    const back = new URL(cb.headers.get("location")!);
    expect(back.origin + back.pathname).toBe("https://posts.example.com/");
    expect(Object.fromEntries(back.searchParams)).toEqual({ postsync: "connected", connector: "LinkedIn", count: "1" });
    expect(form(calls[0])).toMatchObject({ code: "CODE", grant_type: "authorization_code" });
    expect((await api("GET", "/accounts")).json().accounts[0]).toMatchObject({ platform: "linkedin", name: "Tenzin", status: "active" });
  });

  it("uses PKCE for X", async () => {
    const { authUrl, calls } = await connectX();
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    const challenge = authUrl.searchParams.get("code_challenge")!;
    expect(challenge).toMatch(/^[\w-]{43}$/);
    // The token exchange proves it started the flow: sha256(verifier) is the challenge sent earlier.
    const { code_verifier: verifier, ...exchange } = form(calls[0]);
    expect(exchange).toMatchObject({ code: "CODE", grant_type: "authorization_code", redirect_uri: "https://posts.example.com/oauth/x/callback" });
    expect(crypto.createHash("sha256").update(verifier).digest("base64url")).toBe(challenge);
    expect(calls[0].headers.get("authorization")).toMatch(/^Basic /);
  });
});

// ---- owners ---------------------------------------------------------------------------------------------

describe("owners", () => {
  beforeEach(async () => {
    clearBlueskySessions();
    storage = sqliteStorage(":memory:");
    sync = await makeEngine({ storage });
    handler = createHandler(sync, { authenticate: (request) => request.headers.get("x-owner") });
  });

  it("requires the host app's login for everything but OAuth callbacks and media files", async () => {
    expect((await inject({ url: "/accounts" })).status).toBe(401);
    expect((await inject({ url: "/posts" })).status).toBe(401);
    expect((await inject({ method: "POST", url: "/posts", payload: { text: "hi" } })).status).toBe(401);
  });

  it("keeps each owner's accounts, media, posts and jobs apart", async () => {
    const mine = await addBlueskyAccount(OWNER, "me.bsky.social");
    const theirs = await addBlueskyAccount(OTHER, "them.bsky.social");

    // Accounts
    expect((await api("GET", "/accounts", undefined, OTHER)).json().accounts.map((a: any) => a.id)).toEqual([theirs]);
    expect((await api("GET", `/accounts/${mine}`, undefined, OTHER)).status).toBe(404);
    expect((await api("POST", `/accounts/${mine}/check`, undefined, OTHER)).status).toBe(404);
    expect((await api("DELETE", `/accounts/${mine}`, undefined, OTHER)).status).toBe(404);

    // Media, and posting with someone else's account or media
    const media = (await upload(OWNER, "a.jpg", "image/jpeg", Buffer.alloc(500, 3))).json().media[0];
    expect((await api("GET", `/media/${media.id}`, undefined, OTHER)).status).toBe(404);
    const stolenAccount = await api("POST", "/posts", { text: "hi", targets: [{ accountId: mine }] }, OTHER);
    expect(stolenAccount.status).toBe(400);
    expect(stolenAccount.json().error).toMatch(/isn't connected/);
    const stolenMedia = await api("POST", "/posts", { text: "hi", mediaIds: [media.id], targets: [{ accountId: theirs }] }, OTHER);
    expect(stolenMedia.status).toBe(400);
    expect(stolenMedia.json().error).toMatch(/not found/);

    // Posts and their jobs (scheduled, so they stay queued)
    const scheduledAt = Date.now() + 3600_000;
    const post = (await api("POST", "/posts", { text: "mine", mediaIds: [media.id], targets: [{ accountId: mine }], scheduledAt })).json().post;
    const targetId = post.targets[0].id;
    expect((await api("GET", `/posts/${post.id}`, undefined, OTHER)).status).toBe(404);
    expect((await api("GET", "/posts", undefined, OTHER)).json().posts).toEqual([]);
    expect((await api("POST", `/targets/${targetId}/cancel`, undefined, OTHER)).status).toBe(409);
    expect((await api("POST", `/targets/${targetId}/retry`, undefined, OTHER)).status).toBe(409);
    expect((await api("DELETE", `/posts/${post.id}`, undefined, OTHER)).status).toBe(404);
    expect(await sync.targets.cancel(OTHER, targetId)).toBe(false);
    expect(await sync.posts.get(OTHER, post.id)).toBeNull();
    expect((await targetOf(post.id)).status).toBe("queued");

    // The owner's own rules still apply: in-use media and busy accounts stay.
    expect((await api("DELETE", `/media/${media.id}`)).status).toBe(409);
    expect((await api("DELETE", `/accounts/${mine}`)).status).toBe(409);
    expect((await api("POST", `/targets/${targetId}/cancel`)).status).toBe(200);
    expect((await api("DELETE", `/posts/${post.id}`)).status).toBe(200);
    expect((await api("GET", `/media/${media.id}`)).status).toBe(404); // removed with its only post
    expect((await api("DELETE", `/accounts/${mine}`)).status).toBe(200);
    expect((await api("GET", "/accounts")).json().accounts).toEqual([]);
    expect((await api("GET", "/accounts", undefined, OTHER)).json().accounts.map((a: any) => a.id)).toEqual([theirs]);
  });
});

// ---- events ---------------------------------------------------------------------------------------------

describe("events", () => {
  beforeEach(async () => {
    clearBlueskySessions();
    storage = sqliteStorage(":memory:");
    sync = await makeEngine({ storage });
    handler = createHandler(sync, { authenticate: (request) => request.headers.get("x-owner") });
  });

  it("reports each step of a publish", async () => {
    const accountId = await addBlueskyAccount();
    mockFetch(blueskyRoutes(published));
    const names: PostSyncEventName[] = [];
    const off = sync.events.onAny((name) => names.push(name));
    const created = collect("post.created");
    const progress = collect("target.progress");
    const succeeded = collect("target.succeeded");

    const post = (await api("POST", "/posts", { text: "hi", targets: [{ accountId }] })).json().post;
    await sync.worker.runDue();
    expect(names.filter((n) => n !== "target.progress")).toEqual(["post.created", "target.started", "target.succeeded"]);
    expect(created[0].post).toMatchObject({ id: post.id, ownerId: OWNER });
    expect(progress[0].message).toBe("Signing in to Bluesky…");
    expect(succeeded[0].target).toMatchObject({ postId: post.id, ownerId: OWNER, status: "succeeded", remoteUrl: expect.stringContaining("bsky.app") });

    off();
    await api("POST", "/posts", { text: "again", targets: [{ accountId }] });
    await sync.worker.runDue();
    expect(names.filter((n) => n === "post.created")).toHaveLength(1);
    expect(succeeded).toHaveLength(2);
  });

  it("target.failed says whether and when the job will be retried", async () => {
    const accountId = await addBlueskyAccount();
    const failed = collect("target.failed");
    mockFetch([blueskyLoginFails(503, { error: "Unavailable", message: "try later" })]);
    const post = (await api("POST", "/posts", { text: "hi", targets: [{ accountId }] })).json().post;
    await sync.worker.runDue();
    const target = await targetOf(post.id);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ willRetry: true, retryAt: target.runAt, error: expect.stringMatching(/try later/) });
    expect(failed[0].target).toMatchObject({ id: target.id, status: "queued", ownerId: OWNER });

    advanceClock(2 * 60_000);
    mockFetch(blueskyRoutes(() => ({ status: 400, json: { error: "InvalidRequest", message: "bad record" } })));
    await sync.worker.runDue();
    expect(failed).toHaveLength(2);
    expect(failed[1]).toMatchObject({ willRetry: false, retryAt: null, error: expect.stringMatching(/bad record/) });
    expect(failed[1].target.status).toBe("failed");
  });

  it("account.needsReconnect fires when a platform rejects the login", async () => {
    const accountId = await addBlueskyAccount();
    const flagged = collect("account.needsReconnect");
    const failed = collect("target.failed");
    mockFetch([blueskyLoginFails(401, rejectedLogin)]);
    await api("POST", "/posts", { text: "hi", targets: [{ accountId }] });
    await sync.worker.runDue();
    expect(flagged).toHaveLength(1);
    expect(flagged[0].account).toMatchObject({ id: accountId, ownerId: OWNER, status: "needs_reauth" });
    expect(flagged[0].message).toMatch(/Invalid identifier or password/);
    expect(failed[0]).toMatchObject({ willRetry: false, retryAt: null });
  });

  it("never lets a failing listener break connecting or publishing", async () => {
    const errors: string[] = [];
    const engine = await makeEngine({ logger: { info: () => {}, warn: () => {}, error: (message) => errors.push(message) } });
    engine.events.onAny(() => {
      throw new Error("listener bug");
    });
    engine.on("post.created", () => {
      throw new Error("listener bug");
    });
    engine.on("target.succeeded", async () => {
      throw new Error("async listener bug");
    });
    const done = collect("target.succeeded", engine);

    const accountId = await addBlueskyAccount(OWNER, "me.bsky.social", engine);
    mockFetch(blueskyRoutes(published));
    const post = await engine.posts.create(OWNER, { text: "still works", targets: [{ accountId }] });
    expect(await engine.worker.runDue()).toEqual({ processed: 1 });
    await new Promise((resolve) => setImmediate(resolve));

    expect((await engine.posts.get(OWNER, post.id))?.targets[0].status).toBe("succeeded");
    expect(done.map((e) => e.target.status)).toEqual(["succeeded"]);
    expect(errors).toEqual(
      // The error's text is in the message itself (loggers like pino drop a trailing Error argument).
      expect.arrayContaining([
        'listener for "account.connected" failed: listener bug',
        'listener for "post.created" failed: listener bug',
        'listener for "target.started" failed: listener bug',
        'listener for "target.succeeded" failed: listener bug',
        'listener for "target.succeeded" failed: async listener bug',
      ]),
    );
  });
});

// ---- image conversion (needs ffmpeg) -------------------------------------------------------------------

describe.runIf(await hasFfmpeg())("image conversion", () => {
  it("converts PNGs to JPEG, shrinks them under a size limit and serves them at a signed URL", async () => {
    const src = path.join(tempDir(), "big.png");
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=3000x2000", "-frames:v", "1", src]);
    const db = sqliteStorage(":memory:");
    const engine = await makeEngine({ storage: db });
    const uploaded = await engine.media.fromFile(OWNER, src);
    expect(uploaded).toMatchObject({ kind: "image", mime: "image/png", width: 3000, height: 2000, size: fs.statSync(src).size });

    const row = await db.getMedia(OWNER, uploaded.id);
    const jpeg = await engine.store.jpegVariant(engine.store.toFile(row!), { maxBytes: 300_000, maxDimension: 2000 });
    expect(jpeg.mime).toBe("image/jpeg");
    expect(jpeg.size).toBeLessThanOrEqual(300_000);
    expect(Math.max(jpeg.width!, jpeg.height!)).toBeLessThanOrEqual(2000);

    const url = engine.store.publicUrl(jpeg.file);
    expect(engine.store.verifyPublicUrl(new URL(url).pathname.split("/")[2], jpeg.file)).toBe(true);
    const res = await createHandler(engine).fetch(new Request(url));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect((await res.arrayBuffer()).byteLength).toBe(jpeg.size);
  });
});
