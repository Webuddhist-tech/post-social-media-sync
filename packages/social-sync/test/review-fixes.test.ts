/**
 * Regression tests for the second review (of the fixes themselves). Each block names the item it covers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, AuthError, RefreshError, request, retryAfterMs, UserError } from "../src/http.js";
import { bluesky, clearBlueskySessions } from "../src/platforms/bluesky.js";
import { facebook } from "../src/platforms/facebook.js";
import { linkedin, resetLinkedInVersionCache } from "../src/platforms/linkedin.js";
import { threads } from "../src/platforms/threads.js";
import { tiktokPlatform } from "../src/platforms/tiktok.js";
import { x } from "../src/platforms/x.js";
import { youtube } from "../src/platforms/youtube.js";
import { fakeMedia, form, makeCtx, mockFetch, testConfig } from "./helpers.js";

const G = "https://graph.facebook.com/v26.0";
const config = testConfig();
const MB = 1024 * 1024;

beforeEach(() => {
  clearBlueskySessions();
  resetLinkedInVersionCache();
});

describe("shared", () => {
  it("reads X's app-wide daily cap and Bluesky's RateLimit-Reset (shared-3, bsky-new-2)", () => {
    const now = 1_000_000_000_000;
    const app = new Headers({
      "x-rate-limit-reset": String(now / 1000 + 600),
      "x-app-limit-24hour-remaining": "0",
      "x-app-limit-24hour-reset": String(now / 1000 + 20 * 3600),
    });
    expect(retryAfterMs(app, now)).toBe(20 * 3600_000);
    expect(retryAfterMs(new Headers({ "ratelimit-reset": String(now / 1000 + 3600) }), now)).toBe(3600_000);
    expect(retryAfterMs(new Headers({ "ratelimit-reset": "90" }), now)).toBe(90_000);
  });

  it("treats a connection drop while reading the body as a retryable network error (shared-4)", async () => {
    vi.stubGlobal("fetch", async () => new Response(new ReadableStream({ start: (c) => c.error(new TypeError("terminated")) }), { status: 200 }));
    const err = await request("https://api.example.com/x").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
    expect(err.retryable).toBe(true);
  });
});

describe("Facebook Reels (NEW-FB-1 / shared-1)", () => {
  it("never re-publishes a reel when status checks keep failing after it was submitted", async () => {
    mockFetch([
      {
        method: "POST",
        match: `${G}/page-1/video_reels`,
        reply: (c) => (form(c).upload_phase === "start" ? { json: { video_id: "v1", upload_url: "https://rupload.facebook.com/video-upload/v26.0/v1" } } : { json: { success: true } }),
      },
      { method: "POST", match: "https://rupload.facebook.com/", reply: () => ({ json: { success: true } }) },
      { method: "GET", match: `${G}/v1`, reply: () => ({ status: 400, json: { error: { message: "too many calls", code: 80001 } } }) },
    ]);
    const ctx = makeCtx(facebook, {
      config,
      account: { externalId: "page-1" },
      credentials: { pageAccessToken: "T" },
      input: { text: "r", media: [fakeMedia(config, { kind: "video" })], options: { videoFormat: "reel" } },
    });
    const err = await facebook.publish(ctx).catch((e) => e);
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/Facebook may have published/);
  });
});

describe("Threads (th-new-1)", () => {
  it("re-publishes the same container after a lost response", async () => {
    const T = "https://graph.threads.net/v1.0";
    const { calls } = mockFetch([
      { method: "POST", match: `${T}/th-1/threads_publish`, reply: (_c, n) => (n === 1 ? { status: 502, text: "" } : { json: { id: "p1" } }) },
      { method: "POST", match: `${T}/th-1/threads`, reply: () => ({ json: { id: "c-1" } }) },
      { method: "GET", match: T, reply: () => ({ json: { status: "FINISHED", permalink: "https://threads.net/p1" } }) },
    ]);
    const ctx = makeCtx(threads, { config, account: { externalId: "th-1" }, credentials: { accessToken: "T" }, input: { text: "hello" } });
    expect((await threads.publish(ctx)).remoteId).toBe("p1");
    expect(calls.filter((c) => c.url.pathname.endsWith("/threads_publish")).map((c) => form(c).creation_id)).toEqual(["c-1", "c-1"]);
    expect(calls.filter((c) => c.method === "POST" && c.url.pathname.endsWith("/th-1/threads"))).toHaveLength(1);
  });
});

describe("TikTok", () => {
  const API = "https://open.tiktokapis.com/v2";
  const ok = (data: unknown) => ({ json: { data, error: { code: "ok", message: "" } } });
  const base = [
    { method: "POST", match: `${API}/post/publish/creator_info/query/`, reply: () => ok({ creator_username: "me", privacy_level_options: ["SELF_ONLY"] }) },
    { method: "POST", match: `${API}/post/publish/video/init/`, reply: () => ok({ publish_id: "pub", upload_url: "https://up.example/u" }) },
  ];
  const run = async (routes: any[], size: number, credentials: (o?: { force?: boolean }) => Promise<any> = async () => ({ accessToken: "T" })) => {
    const { calls } = mockFetch([...base, ...routes]);
    const ctx = makeCtx(tiktokPlatform, {
      config,
      credentials: {},
      input: { text: "x", media: [fakeMedia(config, { kind: "video", size })], options: { privacyLevel: "SELF_ONLY" } },
    });
    ctx.credentials = credentials;
    const result = await tiktokPlatform.publish(ctx).catch((e) => e);
    return { result, calls };
  };

  it("lets the queue retry when an early chunk fails: nothing can be live (NEW-1)", async () => {
    const { result, calls } = await run(
      [{ method: "PUT", match: "https://up.example/u", reply: (c: any) => (c.headers.get("content-range").startsWith("bytes 0-") ? { status: 503, text: "" } : { status: 206, text: "" }) }],
      70 * MB,
    );
    expect(result).toBeInstanceOf(ApiError);
    expect(result.retryable).toBe(true);
    expect(result.message).not.toMatch(/may have published/);
    expect(calls.some((c) => c.url.pathname.endsWith("/status/fetch/"))).toBe(false);
  });

  it("retries a rate-limited final chunk later instead of polling a half upload (NEW-3)", async () => {
    const { result, calls } = await run([{ method: "PUT", match: "https://up.example/u", reply: () => ({ status: 429, text: "" }) }], 1000);
    expect(result.retryable).toBe(true);
    expect(calls.some((c) => c.url.pathname.endsWith("/status/fetch/"))).toBe(false);
  });

  it("refreshes the token while waiting instead of flagging the account (NEW-2)", async () => {
    let token = "OLD";
    const { result } = await run(
      [
        { method: "PUT", match: "https://up.example/u", reply: () => ({ status: 201, text: "" }) },
        {
          method: "POST",
          match: `${API}/post/publish/status/fetch/`,
          reply: (c: any) => (c.headers.get("authorization") === "Bearer OLD" ? { status: 401, json: { error: { code: "access_token_invalid" } } } : ok({ status: "PUBLISH_COMPLETE" })),
        },
      ],
      1000,
      async (o) => {
        if (o?.force) token = "NEW";
        return { accessToken: token };
      },
    );
    expect(result.remoteId).toBe("pub");
  });

  it("never reports a login problem after the upload: TikTok may still publish (NEW-2)", async () => {
    const { result } = await run(
      [
        { method: "PUT", match: "https://up.example/u", reply: () => ({ status: 201, text: "" }) },
        { method: "POST", match: `${API}/post/publish/status/fetch/`, reply: () => ({ status: 401, json: { error: { code: "access_token_invalid" } } }) },
      ],
      1000,
    );
    expect(result).not.toBeInstanceOf(AuthError);
    expect(result.retryable).toBe(false);
    expect(result.message).toMatch(/check TikTok before retrying/);
  });
});

describe("YouTube", () => {
  const UP = "https://www.googleapis.com/upload/youtube/v3/videos";
  const start = { method: "POST", match: UP, reply: () => ({ text: "", headers: { location: `${UP}?upload_id=S1` } }) };

  it("gives up (retryably) when chunks keep failing even though probes succeed (YT-NEW-1, YT-NEW-2)", async () => {
    const { calls } = mockFetch([
      start,
      {
        method: "PUT",
        match: `${UP}?upload_id=S1`,
        reply: (c) => (c.headers.get("content-range")!.startsWith("bytes */") ? { status: 308, text: "", headers: { range: "bytes=0-999" } } : { status: 503, text: "" }),
      },
    ]);
    const size = 40 * MB;
    const ctx = makeCtx(youtube, { config, credentials: { accessToken: "A" }, input: { text: "t", media: [fakeMedia(config, { kind: "video", size })] } });
    const err = await youtube.publish(ctx).catch((e) => e);
    expect(err.retryable).toBe(true); // the final bytes were never accepted: no video exists
    expect(err.message).not.toMatch(/may have published/);
    expect(calls.length).toBeLessThan(20);
  });

  it("says 'may have published' only when the final bytes may have arrived", async () => {
    mockFetch([
      start,
      { method: "PUT", match: `${UP}?upload_id=S1`, reply: () => ({ status: 503, text: "" }) },
    ]);
    const ctx = makeCtx(youtube, { config, credentials: { accessToken: "A" }, input: { text: "t", media: [fakeMedia(config, { kind: "video", size: 3000 })] } });
    const err = await youtube.publish(ctx).catch((e) => e);
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/YouTube may have published/);
  });
});

describe("X", () => {
  it("keeps a failed token refresh retryable and never sends the post (X-NEW-1, shared-2)", async () => {
    const { calls } = mockFetch([{ method: "POST", match: "https://api.x.com/2/tweets", reply: () => ({ status: 201, json: { data: { id: "t" } } }) }]);
    const ctx = makeCtx(x, { config, credentials: {}, input: { text: "hi" } });
    ctx.credentials = async () => {
      throw new RefreshError(new ApiError("Network error talking to api.x.com", 0, null, true));
    };
    const err = await x.publish(ctx).catch((e) => e);
    expect(err.retryable).toBe(true);
    expect(err.message).not.toMatch(/may have published/);
    expect(calls).toHaveLength(0);
  });
});

describe("connection checks", () => {
  it("LinkedIn Page accounts must still have a posting role (li-new-1)", async () => {
    resetLinkedInVersionCache();
    mockFetch([
      { method: "GET", match: "https://api.linkedin.com/v2/userinfo", reply: () => ({ json: { sub: "me", name: "Me" } }) },
      { method: "GET", match: "https://api.linkedin.com/rest/organizationAcls", reply: () => ({ json: { elements: [{ organization: "urn:li:organization:5", role: "ANALYST" }] } }) },
    ]);
    const err = await linkedin
      .checkConnection({
        config,
        account: { id: "a", ownerId: "o", platform: "linkedin", externalId: "urn:li:organization:5", name: "Lotus", username: null, meta: {} },
        credentials: async () => ({ accessToken: "T" }),
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(UserError);
    expect(err.message).toMatch(/no longer has an Administrator or Content Admin role/);
  });

  it("Bluesky checks talk to the server even with a cached session (bsky-new-1)", async () => {
    let revoked = false;
    const { calls } = mockFetch([
      {
        method: "POST",
        match: "https://bsky.social/xrpc/com.atproto.server.createSession",
        reply: () => (revoked ? { status: 401, json: { error: "AuthenticationRequired", message: "Invalid identifier or password" } } : { json: { did: "did:plc:me", handle: "me.bsky.social", accessJwt: "A", refreshJwt: "R" } }),
      },
      {
        method: "POST",
        match: "https://bsky.social/xrpc/com.atproto.server.refreshSession",
        reply: () => (revoked ? { status: 400, json: { error: "ExpiredToken" } } : { json: { did: "did:plc:me", handle: "me.bsky.social", accessJwt: "A2", refreshJwt: "R2" } }),
      },
      { method: "GET", match: "https://bsky.social/xrpc/com.atproto.server.getSession", reply: () => ({ json: { handle: "me.bsky.social", active: true } }) },
      { method: "POST", match: "https://bsky.social/xrpc/com.atproto.repo.createRecord", reply: () => ({ json: { uri: "at://x/app.bsky.feed.post/1" } }) },
    ]);
    const creds = { identifier: "me", appPassword: "p", service: "https://bsky.social" };
    const account = { id: "a", ownerId: "o", platform: "bluesky" as const, externalId: "did:plc:me", name: "Me", username: null, meta: {} };
    await bluesky.publish(makeCtx(bluesky, { config, credentials: creds, input: { text: "hi" } })); // caches a session
    expect(await bluesky.checkConnection({ config, account, credentials: async () => creds })).toBe("Can post as @me.bsky.social.");
    expect(calls.some((c) => c.url.pathname.endsWith("refreshSession"))).toBe(true);
    revoked = true;
    await expect(bluesky.checkConnection({ config, account, credentials: async () => creds })).rejects.toBeInstanceOf(AuthError);
  });
});
