/**
 * Regression tests for the API-conformance review (each block names the finding it covers).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, AuthError, extractErrorMessage, publishStep, retryAfterMs, UserError } from "../src/http.js";
import { bluesky, clearBlueskySessions, detectFacets } from "../src/platforms/bluesky.js";
import { facebook } from "../src/platforms/facebook.js";
import { instagram } from "../src/platforms/instagram.js";
import { linkedin, linkedinConnector, resetLinkedInVersionCache } from "../src/platforms/linkedin.js";
import { graph, metaConnector } from "../src/platforms/meta.js";
import { threads } from "../src/platforms/threads.js";
import { publicPostId, tiktokConnector, tiktokPlatform } from "../src/platforms/tiktok.js";
import type { Platform, PublishInput } from "../src/platforms/types.js";
import { x } from "../src/platforms/x.js";
import { googleConnector, parseTags, tagsLength, youtube, youtubeTitle } from "../src/platforms/youtube.js";
import { validateForPlatform, withDefaults } from "../src/posts.js";
import { measureText } from "../src/text.js";
import { fakeMedia, form, makeCtx, mockFetch, testConfig } from "./helpers.js";

const G = "https://graph.facebook.com/v26.0";
const config = testConfig();
const input = (p: Platform, partial: Partial<PublishInput>): PublishInput => ({
  text: "",
  title: null,
  media: [],
  ...partial,
  options: withDefaults(p, partial.options),
});

beforeEach(() => {
  clearBlueskySessions();
  resetLinkedInVersionCache();
});

describe("shared HTTP handling", () => {
  it("reads rate-limit reset times (Retry-After, X 15-minute and 24-hour windows)", () => {
    const now = 1_000_000_000_000;
    expect(retryAfterMs(new Headers({ "retry-after": "120" }), now)).toBe(120_000);
    expect(retryAfterMs(new Headers({ "x-rate-limit-reset": String(now / 1000 + 900) }), now)).toBe(900_000);
    const daily = new Headers({
      "x-rate-limit-reset": String(now / 1000 + 60),
      "x-user-limit-24hour-remaining": "0",
      "x-user-limit-24hour-reset": String(now / 1000 + 36_000),
    });
    expect(retryAfterMs(daily, now)).toBe(36_000_000);
    expect(retryAfterMs(new Headers(), now)).toBeNull();
  });

  it("keeps X's specific error reasons (x-6)", () => {
    expect(
      extractErrorMessage({
        title: "Invalid Request",
        detail: "One or more parameters to your request was invalid.",
        errors: [{ message: "Your media IDs are invalid." }],
      }),
    ).toBe("Invalid Request: One or more parameters to your request was invalid. — Your media IDs are invalid.");
  });

  it("never lets the queue blindly retry a request whose outcome is unknown", async () => {
    const network = new ApiError("Network error", 0, null, true);
    const server = new ApiError("boom", 502, null, true);
    const limited = new ApiError("slow down", 429, null, true);
    const metaLimit = new ApiError("limit", 400, { error: { code: 4 } }, true);
    for (const err of [network, server]) {
      const out = await publishStep("Facebook", () => Promise.reject(err)).catch((e) => e);
      expect(out.retryable).toBe(false);
      expect(out.message).toMatch(/Facebook may have published this post/);
    }
    for (const err of [limited, metaLimit]) {
      expect(await publishStep("Facebook", () => Promise.reject(err)).catch((e) => e)).toBe(err);
    }
  });
});

describe("character counting", () => {
  it("counts like X's own library (x-3, x-4)", () => {
    expect(measureText("x", "👨‍👩‍👧‍👦")).toBe(2);
    expect(measureText("x", "❤️ 🇺🇸")).toBe(5);
    expect(measureText("x", "see x.co")).toBe(27);
    expect(measureText("x", "é")).toBe(1);
  });

  it("counts Threads emoji as UTF-8 bytes (th-3) and TikTok in UTF-16 units (tt-5)", () => {
    expect(measureText("threads", "hi 😀")).toBe(7);
    expect(measureText("threads", "©")).toBe(1);
    expect(measureText("tiktok", "😀")).toBe(2);
  });
});

describe("Meta", () => {
  it("retries Business Use Case rate limits and posting-speed blocks (fb-1, fb-7, ig-5)", async () => {
    for (const error of [{ code: 80001 }, { code: 80002 }, { code: 368, error_subcode: 1390008 }]) {
      mockFetch([{ match: G, reply: () => ({ status: 400, json: { error: { message: "slow down", ...error } } }) }]);
      const err = await graph(`${G}/x`).catch((e) => e);
      expect(err.retryable).toBe(true);
    }
    mockFetch([{ match: G, reply: () => ({ status: 400, json: { error: { message: "policy", code: 368 } } }) }]);
    expect((await graph(`${G}/x`).catch((e) => e)).retryable).toBe(false);
  });

  it("explains permission errors", async () => {
    mockFetch([{ match: G, reply: () => ({ status: 403, json: { error: { message: "(#200) Permissions error", code: 200 } } }) }]);
    const err = await graph(`${G}/x`, {}, { permissionHint: "Check your Page role." }).catch((e) => e);
    expect(err).toBeInstanceOf(UserError);
    expect(err.message).toMatch(/Check your Page role/);
  });

  it("skips Pages you can't post to and respects declined permissions (fb-8)", async () => {
    mockFetch([
      { match: `${G}/oauth/access_token`, reply: () => ({ json: { access_token: "TOKEN" } }) },
      {
        match: `${G}/me/permissions`,
        reply: () => ({
          json: {
            data: [
              { permission: "pages_show_list", status: "granted" },
              { permission: "pages_manage_posts", status: "granted" },
              { permission: "instagram_basic", status: "granted" },
              { permission: "instagram_content_publish", status: "declined" },
            ],
          },
        }),
      },
      {
        match: `${G}/me/accounts`,
        reply: () => ({
          json: {
            data: [
              { id: "p1", name: "Good Page", access_token: "PT1", tasks: ["CREATE_CONTENT", "MANAGE"], instagram_business_account: { id: "ig1", username: "good" } },
              { id: "p2", name: "Analyst Page", access_token: "PT2", tasks: ["ANALYZE"] },
              { id: "p3", name: "No Token Page" },
            ],
          },
        }),
      },
    ]);
    const drafts = await metaConnector.exchangeCode!(config, { code: "c", redirectUri: "r", codeVerifier: null, query: {} });
    expect(drafts.map((d) => `${d.platform}:${d.externalId}`)).toEqual(["facebook:p1"]); // IG permission was declined
  });

  it("can request extra permissions such as ads_read (ig-4)", () => {
    const url = new URL(
      metaConnector.authorizeUrl!(testConfig({ meta: { ...config.meta, extraScopes: ["ads_read"] } }), {
        state: "s",
        redirectUri: "r",
        codeChallenge: null,
      }),
    );
    expect(url.searchParams.get("scope")).toContain("ads_read");
  });
});

describe("Facebook", () => {
  it("validates Reels and long videos up front (fb-2, fb-3)", () => {
    const landscapeLong = fakeMedia(config, { kind: "video", width: 1920, height: 1080, duration: 120 });
    const errors = validateForPlatform(facebook, input(facebook, { media: [landscapeLong], options: { videoFormat: "reel" } }), config);
    expect(errors.join(" ")).toMatch(/3–90 seconds/);
    expect(errors.join(" ")).toMatch(/vertical/);
    const long = fakeMedia(config, { kind: "video", duration: 25 * 60 });
    expect(validateForPlatform(facebook, input(facebook, { media: [long] }), config).join(" ")).toMatch(/20 minutes/);
  });

  it("shrinks photos over 4 MB and converts WebP before uploading (fb-4)", async () => {
    mockFetch([
      { method: "POST", match: `${G}/page-1/photos`, reply: () => ({ json: { id: "ph", post_id: "page-1_9" } }) },
      { method: "GET", match: G, reply: () => ({ json: { permalink_url: "/x" } }) },
    ]);
    const big = fakeMedia(config, { kind: "image", size: 5_000_000 });
    const ctx = makeCtx(facebook, { config, account: { externalId: "page-1" }, credentials: { pageAccessToken: "T" }, input: { text: "x", media: [big] } });
    const small = { ...big, size: 1000 };
    const spy = vi.spyOn(ctx.media, "jpegVariant").mockResolvedValue(small);
    await facebook.publish(ctx);
    expect(spy).toHaveBeenCalledWith(big, { maxBytes: 4_000_000 });
  });

  it("uploads regular videos to graph.facebook.com (fb-6)", async () => {
    const { calls } = mockFetch([
      { method: "POST", match: `${G}/page-1/videos`, reply: () => ({ json: { id: "v1" } }) },
      { method: "GET", match: G, reply: () => ({ json: {} }) },
    ]);
    const ctx = makeCtx(facebook, {
      config,
      account: { externalId: "page-1" },
      credentials: { pageAccessToken: "T" },
      input: { text: "x", media: [fakeMedia(config, { kind: "video" })] },
    });
    await facebook.publish(ctx);
    expect(calls[0].url.host).toBe("graph.facebook.com");
  });
});

describe("Instagram", () => {
  const statuses = (status: string) => ({
    method: "GET",
    match: `${G}/?ids=`,
    reply: (c: { url: URL }) => ({ json: Object.fromEntries(c.url.searchParams.get("ids")!.split(",").map((id) => [id, { status_code: status }])) }),
  });

  it("does not publish twice when media_publish's response is lost (ig-1)", async () => {
    const { calls } = mockFetch([
      { method: "POST", match: `${G}/ig-1/media_publish`, reply: () => ({ status: 500, json: { error: { message: "unknown", code: 1 } } }) },
      { method: "POST", match: `${G}/ig-1/media`, reply: () => ({ json: { id: "c1" } }) },
      statuses("FINISHED"),
      { method: "GET", match: `${G}/c1`, reply: () => ({ json: { status_code: "PUBLISHED" } }) },
    ]);
    const ctx = makeCtx(instagram, {
      config,
      account: { externalId: "ig-1" },
      credentials: { accessToken: "T" },
      input: { text: "x", media: [fakeMedia(config, { kind: "image" })] },
    });
    const res = await instagram.publish(ctx);
    expect(res.remoteId).toBe("c1");
    expect(calls.filter((c) => c.url.pathname.endsWith("media_publish"))).toHaveLength(1);
  });

  it("re-publishes the same container when a lost response turns out not to have published (th-new-1)", async () => {
    const { calls } = mockFetch([
      { method: "POST", match: `${G}/ig-1/media_publish`, reply: (_c, n) => (n === 1 ? { status: 503, json: {} } : { json: { id: "media-1" } }) },
      { method: "POST", match: `${G}/ig-1/media`, reply: () => ({ json: { id: "c1" } }) },
      statuses("FINISHED"),
      { method: "GET", match: `${G}/c1`, reply: () => ({ json: { status_code: "FINISHED" } }) },
      { method: "GET", match: `${G}/media-1`, reply: () => ({ json: { permalink: "https://instagram.com/p/1" } }) },
    ]);
    const ctx = makeCtx(instagram, {
      config,
      account: { externalId: "ig-1" },
      credentials: { accessToken: "T" },
      input: { text: "x", media: [fakeMedia(config, { kind: "image" })] },
    });
    const res = await instagram.publish(ctx);
    expect(res.remoteId).toBe("media-1");
    const publishes = calls.filter((c) => c.url.pathname.endsWith("media_publish")).map((c) => form(c).creation_id);
    expect(publishes).toEqual(["c1", "c1"]); // same container, never a new one
    expect(calls.filter((c) => c.method === "POST" && c.url.pathname.endsWith("/ig-1/media"))).toHaveLength(1);
  });

  it("reports 'check before retrying' when it can't tell", async () => {
    mockFetch([
      { method: "POST", match: `${G}/ig-1/media_publish`, reply: () => ({ status: 503, json: {} }) },
      { method: "POST", match: `${G}/ig-1/media`, reply: () => ({ json: { id: "c1" } }) },
      statuses("FINISHED"),
      { method: "GET", match: `${G}/c1`, reply: () => ({ json: { status_code: "IN_PROGRESS" } }) },
    ]);
    const ctx = makeCtx(instagram, {
      config,
      account: { externalId: "ig-1" },
      credentials: { accessToken: "T" },
      input: { text: "x", media: [fakeMedia(config, { kind: "image" })] },
    });
    const err = await instagram.publish(ctx).catch((e) => e);
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/may have published/);
  });

  it("treats Meta's 'unknown error' codes as unknown outcomes even with a 4xx status (IG-N1)", async () => {
    const { calls } = mockFetch([
      {
        method: "POST",
        match: `${G}/ig-1/media_publish`,
        reply: () => ({ status: 400, json: { error: { message: "An unknown error occurred", code: 1, is_transient: true } } }),
      },
      { method: "POST", match: `${G}/ig-1/media`, reply: () => ({ json: { id: "c1" } }) },
      statuses("FINISHED"),
      { method: "GET", match: `${G}/c1`, reply: () => ({ json: { status_code: "PUBLISHED" } }) },
      { method: "GET", match: `${G}/ig-1/media`, reply: () => ({ json: { data: [{ id: "m9", permalink: "https://instagram.com/p/9", timestamp: new Date().toISOString() }] } }) },
    ]);
    const ctx = makeCtx(instagram, {
      config,
      account: { externalId: "ig-1" },
      credentials: { accessToken: "T" },
      input: { text: "x", media: [fakeMedia(config, { kind: "image" })] },
    });
    expect(await instagram.publish(ctx)).toEqual({ remoteId: "m9", url: "https://instagram.com/p/9" });
    expect(calls.filter((c) => c.url.pathname.endsWith("media_publish"))).toHaveLength(1);
  });

  it("validates video limits and mentions (ig-3, ig-7)", () => {
    const longReel = fakeMedia(config, { kind: "video", duration: 16 * 60 });
    expect(validateForPlatform(instagram, input(instagram, { media: [longReel] }), config).join(" ")).toMatch(/15 minutes/);
    const clip = fakeMedia(config, { kind: "video", duration: 90, width: 1080, height: 1080 });
    const photo = fakeMedia(config, { kind: "image" });
    expect(validateForPlatform(instagram, input(instagram, { media: [clip, photo] }), config).join(" ")).toMatch(/3–60 seconds/);
    const tall = fakeMedia(config, { kind: "video", duration: 10, width: 1080, height: 1920 });
    expect(validateForPlatform(instagram, input(instagram, { media: [tall, photo] }), config).join(" ")).toMatch(/carousel videos/);
    const mentions = Array.from({ length: 21 }, (_, i) => `@user${i}`).join(" ");
    expect(validateForPlatform(instagram, input(instagram, { text: mentions, media: [photo] }), config).join(" ")).toMatch(/20 @mentions/);
  });
});

describe("Threads", () => {
  it("validates links, video format, size and length (th-2, th-4)", () => {
    const links = Array.from({ length: 6 }, (_, i) => `https://e.com/${i}`).join(" ");
    expect(validateForPlatform(threads, input(threads, { text: links }), config).join(" ")).toMatch(/5 links/);
    const webm = fakeMedia(config, { kind: "video", mime: "video/webm", duration: 400 });
    const errors = validateForPlatform(threads, input(threads, { media: [webm] }), config).join(" ");
    expect(errors).toMatch(/MP4 or MOV/);
    expect(errors).toMatch(/5 minutes/);
  });

  it("converts PNGs over 8 MB (th-1)", async () => {
    const T = "https://graph.threads.net/v1.0";
    mockFetch([
      { method: "POST", match: `${T}/th-1/threads_publish`, reply: () => ({ json: { id: "p" } }) },
      { method: "POST", match: `${T}/th-1/threads`, reply: () => ({ json: { id: "c" } }) },
      { method: "GET", match: T, reply: () => ({ json: { status: "FINISHED", permalink: "x" } }) },
    ]);
    const png = fakeMedia(config, { kind: "image", mime: "image/png", size: 9_000_000 });
    const ctx = makeCtx(threads, { config, account: { externalId: "th-1" }, credentials: { accessToken: "T" }, input: { media: [png] } });
    const spy = vi.spyOn(ctx.media, "jpegVariant").mockResolvedValue({ ...png, mime: "image/jpeg", size: 1000 });
    await threads.publish(ctx);
    expect(spy).toHaveBeenCalled();
  });
});

describe("TikTok", () => {
  const API = "https://open.tiktokapis.com/v2";
  const ok = (data: unknown) => ({ json: { data, error: { code: "ok", message: "" } } });
  const creatorInfo = { method: "POST", match: `${API}/post/publish/creator_info/query/`, reply: () => ok({ creator_username: "me", privacy_level_options: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"] }) };
  const init = { method: "POST", match: `${API}/post/publish/video/init/`, reply: () => ok({ publish_id: "pub", upload_url: "https://up.example/u" }) };

  it("keeps the full 64-bit post id (tt-1)", async () => {
    expect(publicPostId('{"data":{"publicaly_available_post_id":[7311234567890123456]}}')).toBe("7311234567890123456");
    mockFetch([
      creatorInfo,
      init,
      { method: "PUT", match: "https://up.example/u", reply: () => ({ status: 201, text: "" }) },
      {
        method: "POST",
        match: `${API}/post/publish/status/fetch/`,
        reply: () => ({ text: '{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7311234567890123456]},"error":{"code":"ok"}}' }),
      },
    ]);
    const ctx = makeCtx(tiktokPlatform, {
      config,
      credentials: { accessToken: "T" },
      input: { text: "x", media: [fakeMedia(config, { kind: "video" })], options: { privacyLevel: "PUBLIC_TO_EVERYONE" } },
    });
    const res = await tiktokPlatform.publish(ctx);
    expect(res.url).toBe("https://www.tiktok.com/@me/video/7311234567890123456");
  });

  it("rides out temporary errors after the upload instead of posting twice (tt-2)", async () => {
    const { calls } = mockFetch([
      creatorInfo,
      init,
      { method: "PUT", match: "https://up.example/u", reply: () => ({ status: 201, text: "" }) },
      {
        method: "POST",
        match: `${API}/post/publish/status/fetch/`,
        reply: (_c, n) => (n < 3 ? { status: 503, text: "" } : ok({ status: "PUBLISH_COMPLETE" })),
      },
    ]);
    const ctx = makeCtx(tiktokPlatform, {
      config,
      credentials: { accessToken: "T" },
      input: { text: "x", media: [fakeMedia(config, { kind: "video" })], options: { privacyLevel: "SELF_ONLY" } },
    });
    await tiktokPlatform.publish(ctx);
    expect(calls.filter((c) => c.url.pathname.endsWith("/video/init/"))).toHaveLength(1);
  });

  it("checks the status when the final chunk's response is lost", async () => {
    mockFetch([
      creatorInfo,
      init,
      { method: "PUT", match: "https://up.example/u", reply: () => ({ status: 502, text: "" }) },
      { method: "POST", match: `${API}/post/publish/status/fetch/`, reply: () => ok({ status: "PUBLISH_COMPLETE" }) },
    ]);
    const ctx = makeCtx(tiktokPlatform, {
      config,
      credentials: { accessToken: "T" },
      input: { text: "x", media: [fakeMedia(config, { kind: "video" })], options: { privacyLevel: "SELF_ONLY" } },
    });
    expect((await tiktokPlatform.publish(ctx)).remoteId).toBe("pub");
  });

  it("requires choosing privacy and keeps interactions off by default (tt-3)", () => {
    const opts = withDefaults(tiktokPlatform, {});
    expect(opts.privacyLevel).toBeNull();
    expect([opts.allowComments, opts.allowDuet, opts.allowStitch]).toEqual([false, false, false]);
    const video = fakeMedia(config, { kind: "video" });
    expect(validateForPlatform(tiktokPlatform, input(tiktokPlatform, { media: [video] }), config)).toContain("Choose who can view this TikTok post.");
    expect(validateForPlatform(tiktokPlatform, input(tiktokPlatform, { media: [video], options: { mode: "inbox" } }), config)).toEqual([]);
  });

  it("flags a revoked TikTok login for reconnecting (tt-4)", async () => {
    mockFetch([
      {
        method: "POST",
        match: `${API}/oauth/token/`,
        reply: () => ({ status: 400, json: { error: "invalid_grant", error_description: "Refresh token is invalid", log_id: "x" } }),
      },
    ]);
    const err = await tiktokConnector.refresh!(config, {} as any, { refreshToken: "r", refreshExpiresAt: Date.now() + 1e9 }).catch((e) => e);
    expect(err).toBeInstanceOf(AuthError);
  });
});

describe("LinkedIn", () => {
  const REST = "https://api.linkedin.com/rest";

  it("finds Pages where you're Admin or Content Admin, across result pages (li-1, li-2)", async () => {
    const orgConfig = testConfig({ linkedin: { ...config.linkedin, organizations: true } });
    const { calls } = mockFetch([
      { method: "POST", match: "https://www.linkedin.com/oauth/v2/accessToken", reply: () => ({ json: { access_token: "T", expires_in: 100 } }) },
      { method: "GET", match: "https://api.linkedin.com/v2/userinfo", reply: () => ({ json: { sub: "me", name: "Me" } }) },
      {
        method: "GET",
        match: `${REST}/organizationAcls`,
        reply: (c) => {
          const start = Number(c.url.searchParams.get("start"));
          if (start === 0) {
            const rows = Array.from({ length: 100 }, (_, i) => ({ organization: `urn:li:organization:${i % 3}`, role: ["ADMINISTRATOR", "CONTENT_ADMINISTRATOR", "ANALYST"][i % 3] }));
            return { json: { elements: rows } };
          }
          return { json: { elements: [{ organization: "urn:li:organization:9", role: "CONTENT_ADMINISTRATOR" }] } };
        },
      },
      { method: "GET", match: `${REST}/organizations/`, reply: (c) => ({ json: { localizedName: `Org ${c.url.pathname.split("/").pop()}` } }) },
    ]);
    const drafts = await linkedinConnector.exchangeCode!(orgConfig, { code: "c", redirectUri: "r", codeVerifier: null, query: {} });
    expect(drafts.map((d) => d.externalId)).toEqual(["urn:li:person:me", "urn:li:organization:0", "urn:li:organization:1", "urn:li:organization:9"]);
    const acl = calls.find((c) => c.url.pathname.endsWith("organizationAcls"))!;
    expect(acl.url.searchParams.get("role")).toBeNull();
  });

  it("waits for images to be processed and shrinks huge ones (li-3)", async () => {
    const { calls } = mockFetch([
      { method: "POST", match: `${REST}/images?action=initializeUpload`, reply: () => ({ json: { value: { uploadUrl: "https://up.li/1", image: "urn:li:image:1" } } }) },
      { method: "PUT", match: "https://up.li/1", reply: () => ({ text: "" }) },
      { method: "GET", match: `${REST}/images/`, reply: (_c, n) => ({ json: { status: n < 2 ? "PROCESSING" : "AVAILABLE" } }) },
      { method: "POST", match: `${REST}/posts`, reply: () => ({ status: 201, text: "", headers: { "x-restli-id": "urn:li:share:1" } }) },
    ]);
    const huge = fakeMedia(config, { kind: "image", width: 8000, height: 6000 });
    const ctx = makeCtx(linkedin, { config, account: { externalId: "urn:li:organization:5" }, credentials: { accessToken: "T" }, input: { text: "x", media: [huge] } });
    const spy = vi.spyOn(ctx.media, "jpegVariant").mockResolvedValue({ ...huge, width: 6000, height: 4500 });
    await linkedin.publish(ctx);
    expect(spy).toHaveBeenCalledWith(huge, { maxDimension: 6000 });
    expect(calls.filter((c) => c.url.pathname.startsWith("/rest/images/"))).toHaveLength(2);
  });
});

describe("YouTube", () => {
  const UP = "https://www.googleapis.com/upload/youtube/v3/videos";
  const start = { method: "POST", match: UP, reply: () => ({ text: "", headers: { location: `${UP}?upload_id=S1` } }) };

  it("resumes an interrupted upload from where YouTube left off (yt-1)", async () => {
    const { calls } = mockFetch([
      start,
      {
        method: "PUT",
        match: `${UP}?upload_id=S1`,
        reply: (c, n) => {
          const range = c.headers.get("content-range")!;
          if (n === 1) return { status: 503, text: "" }; // first chunk send fails
          if (range === "bytes */3000") return { status: 308, text: "", headers: { range: "bytes=0-999" } }; // probe: has 1000 bytes
          return { json: { id: "vid", status: { privacyStatus: "public" } } };
        },
      },
    ]);
    const ctx = makeCtx(youtube, {
      config,
      credentials: { accessToken: "A" },
      input: { text: "t", media: [fakeMedia(config, { kind: "video", size: 3000 })] },
    });
    const res = await youtube.publish(ctx);
    expect(res.remoteId).toBe("vid");
    const puts = calls.filter((c) => c.method === "PUT").map((c) => c.headers.get("content-range"));
    expect(puts).toEqual(["bytes 0-2999/3000", "bytes */3000", "bytes 1000-2999/3000"]);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1); // one session, one video
  });

  it("finishes when the lost final response actually completed the upload", async () => {
    mockFetch([
      start,
      {
        method: "PUT",
        match: `${UP}?upload_id=S1`,
        reply: (c, n) => (n === 1 ? { status: 502, text: "" } : { json: { id: "vid", status: { privacyStatus: "public" } } }),
      },
    ]);
    const ctx = makeCtx(youtube, { config, credentials: { accessToken: "A" }, input: { text: "t", media: [fakeMedia(config, { kind: "video" })] } });
    expect((await youtube.publish(ctx)).remoteId).toBe("vid");
  });

  it("refreshes the token once when it expires mid-upload (yt-3)", async () => {
    const { calls } = mockFetch([
      start,
      {
        method: "PUT",
        match: `${UP}?upload_id=S1`,
        reply: (c) => (c.headers.get("authorization") === "Bearer OLD" ? { status: 401, json: { error: { message: "Invalid Credentials" } } } : { json: { id: "vid" } }),
      },
    ]);
    const ctx = makeCtx(youtube, { config, credentials: { accessToken: "OLD" }, input: { text: "t", media: [fakeMedia(config, { kind: "video" })] } });
    let token = "OLD";
    ctx.credentials = async (opts) => {
      if (opts?.force) token = "NEW";
      return { accessToken: token };
    };
    expect((await youtube.publish(ctx)).remoteId).toBe("vid");
    expect(calls.at(-1)!.headers.get("authorization")).toBe("Bearer NEW");
  });

  it("explains quota errors and retries throttling (yt-7)", async () => {
    const run = async (reason: string) => {
      mockFetch([{ method: "POST", match: UP, reply: () => ({ status: 403, json: { error: { message: reason, errors: [{ reason }] } } }) }]);
      const ctx = makeCtx(youtube, { config, credentials: { accessToken: "A" }, input: { text: "t", media: [fakeMedia(config, { kind: "video" })] } });
      return youtube.publish(ctx).catch((e) => e);
    };
    const quota = await run("quotaExceeded");
    expect(quota.message).toMatch(/quota/);
    expect(quota.retryable).toBe(false);
    expect((await run("rateLimitExceeded")).retryable).toBe(true);
  });

  it("rejects partial consent (yt-2)", async () => {
    mockFetch([
      {
        method: "POST",
        match: "https://oauth2.googleapis.com/token",
        reply: () => ({ json: { access_token: "A", refresh_token: "R", expires_in: 3600, scope: "https://www.googleapis.com/auth/youtube.readonly" } }),
      },
    ]);
    const err = await googleConnector.exchangeCode!(config, { code: "c", redirectUri: "r", codeVerifier: null, query: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(UserError);
  });

  it("checks the tag budget and title edge cases (yt-5, yt-6)", () => {
    expect(tagsLength(parseTags("a, b c, #d"))).toBe(1 + 3 + 2 + 1 + 2);
    const tags = Array.from({ length: 60 }, (_, i) => `tag number ${i}`).join(",");
    expect(validateForPlatform(youtube, input(youtube, { text: "x", media: [fakeMedia(config, { kind: "video" })], options: { tags } }), config).join(" ")).toMatch(/500 characters/);
    expect(youtubeTitle("<>", "")).toBe("Untitled");
    const emojiTitle = youtubeTitle(null, "a".repeat(98) + "😀😀😀");
    expect(Array.from(emojiTitle)).toHaveLength(100);
    expect(emojiTitle.endsWith("…")).toBe(true);
    expect(emojiTitle).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });
});

describe("X", () => {
  const A = "https://api.x.com/2";

  it("shrinks photos over 5 MB and checks video limits (x-1, x-5)", async () => {
    mockFetch([
      { method: "POST", match: `${A}/media/upload/initialize`, reply: () => ({ json: { data: { id: "m" } } }) },
      { method: "POST", match: `${A}/media/upload/m/append`, reply: () => ({ status: 204 }) },
      { method: "POST", match: `${A}/media/upload/m/finalize`, reply: () => ({ json: { data: { id: "m" } } }) },
      { method: "POST", match: `${A}/tweets`, reply: () => ({ status: 201, json: { data: { id: "t" } } }) },
    ]);
    const big = fakeMedia(config, { kind: "image", size: 6 * 1024 * 1024 });
    const ctx = makeCtx(x, { config, credentials: { accessToken: "X" }, input: { text: "hi", media: [big] } });
    const spy = vi.spyOn(ctx.media, "jpegVariant").mockResolvedValue({ ...big, size: 1000 });
    await x.publish(ctx);
    expect(spy).toHaveBeenCalledWith(big, { maxBytes: 5 * 1024 * 1024 });

    const long = fakeMedia(config, { kind: "video", duration: 200 });
    expect(validateForPlatform(x, input(x, { media: [long] }), config).join(" ")).toMatch(/2:20/);
    expect(validateForPlatform(x, input(x, { media: [long], options: { premium: true } }), config)).toEqual([]);
  });

  it("refreshes an expired token mid-publish instead of flagging the account (x-2)", async () => {
    const { calls } = mockFetch([
      {
        method: "POST",
        match: `${A}/tweets`,
        reply: (c) => (c.headers.get("authorization") === "Bearer OLD" ? { status: 401, json: { title: "Unauthorized", detail: "Unauthorized" } } : { status: 201, json: { data: { id: "t" } } }),
      },
    ]);
    const ctx = makeCtx(x, { config, credentials: {}, input: { text: "hi" } });
    let token = "OLD";
    ctx.credentials = async (opts) => {
      if (opts?.force) token = "NEW";
      return { accessToken: token };
    };
    expect((await x.publish(ctx)).remoteId).toBe("t");
    expect(calls).toHaveLength(2);
  });

  it("doesn't retry a post whose creation outcome is unknown (x-7)", async () => {
    mockFetch([{ method: "POST", match: `${A}/tweets`, reply: () => ({ status: 503, json: { title: "Service Unavailable", detail: "x" } }) }]);
    const ctx = makeCtx(x, { config, credentials: { accessToken: "X" }, input: { text: "hi" } });
    const err = await x.publish(ctx).catch((e) => e);
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/X may have published/);
  });
});

describe("Bluesky", () => {
  const PDS = "https://bsky.social";
  const session = (n = 1) => ({ json: { did: "did:plc:me", handle: "me.bsky.social", accessJwt: `JWT${n}`, refreshJwt: "R" } });

  it("uses the blob a failed 'already_exists' job returns (bsky-1) and rides out poll errors (bsky-6)", async () => {
    mockFetch([
      { method: "POST", match: `${PDS}/xrpc/com.atproto.server.createSession`, reply: () => session() },
      { method: "GET", match: `${PDS}/xrpc/com.atproto.server.getServiceAuth`, reply: () => ({ json: { token: "S" } }) },
      { method: "POST", match: "https://video.bsky.app/xrpc/app.bsky.video.uploadVideo", reply: () => ({ json: { jobId: "j" } }) },
      {
        method: "GET",
        match: "https://video.bsky.app/xrpc/app.bsky.video.getJobStatus",
        reply: (_c, n) =>
          n === 1 ? { status: 502, text: "" } : { json: { jobStatus: { state: "JOB_STATE_FAILED", error: "already_exists", blob: { ref: "old" } } } },
      },
      { method: "POST", match: `${PDS}/xrpc/com.atproto.repo.createRecord`, reply: () => ({ json: { uri: "at://did:plc:me/app.bsky.feed.post/1" } }) },
    ]);
    const ctx = makeCtx(bluesky, { config, credentials: { identifier: "me", appPassword: "p", service: PDS }, input: { media: [fakeMedia(config, { kind: "video" })] } });
    expect((await bluesky.publish(ctx)).remoteId).toBe("at://did:plc:me/app.bsky.feed.post/1");
  });

  it("reuses the login session between posts (bsky-7)", async () => {
    const { calls } = mockFetch([
      { method: "POST", match: `${PDS}/xrpc/com.atproto.server.createSession`, reply: () => session() },
      { method: "POST", match: `${PDS}/xrpc/com.atproto.repo.createRecord`, reply: () => ({ json: { uri: "at://x/app.bsky.feed.post/1" } }) },
    ]);
    for (let i = 0; i < 3; i++) {
      const ctx = makeCtx(bluesky, { config, credentials: { identifier: "me", appPassword: "p", service: PDS }, input: { text: `post ${i}` } });
      await bluesky.publish(ctx);
    }
    expect(calls.filter((c) => c.url.pathname.endsWith("createSession"))).toHaveLength(1);
  });

  it("logs in again when a reused session has expired", async () => {
    let logins = 0;
    const { calls } = mockFetch([
      { method: "POST", match: `${PDS}/xrpc/com.atproto.server.createSession`, reply: () => session(++logins) },
      {
        method: "POST",
        match: `${PDS}/xrpc/com.atproto.repo.createRecord`,
        reply: (c) =>
          c.headers.get("authorization") === "Bearer JWT1" && logins > 0 && calls.length > 2
            ? { status: 400, json: { error: "ExpiredToken", message: "Token has expired" } }
            : { json: { uri: "at://x/app.bsky.feed.post/1" } },
      },
    ]);
    const creds = { identifier: "me", appPassword: "p", service: PDS };
    await bluesky.publish(makeCtx(bluesky, { config, credentials: creds, input: { text: "one" } }));
    await bluesky.publish(makeCtx(bluesky, { config, credentials: creds, input: { text: "two" } }));
    expect(logins).toBe(2);
  });

  it("detects links, tags and mentions like Bluesky's own app (bsky-4, bsky-5)", async () => {
    const text = "Read https://en.wikipedia.org/wiki/Mercury_(planet). #हिंदी #covid-19 x@notamention.com (https://a.example/b) @alice.bsky.social.";
    const facets = await detectFacets(text, async () => "did:plc:alice");
    const slice = (f: (typeof facets)[number]) => Buffer.from(text).subarray(f.index.byteStart, f.index.byteEnd).toString();
    expect(facets.map(slice)).toEqual([
      "https://en.wikipedia.org/wiki/Mercury_(planet)",
      "#हिंदी",
      "#covid-19",
      "https://a.example/b",
      "@alice.bsky.social",
    ]);
  });

  it("uses the current limits: 2 MB images, 300 MB / 10 min videos (bsky-2, bsky-3)", async () => {
    const video = fakeMedia(config, { kind: "video", size: 200_000_000, duration: 500 });
    expect(validateForPlatform(bluesky, input(bluesky, { media: [video] }), config)).toEqual([]);
    const tooLong = fakeMedia(config, { kind: "video", duration: 700 });
    expect(validateForPlatform(bluesky, input(bluesky, { media: [tooLong] }), config).join(" ")).toMatch(/10 minutes/);

    const { calls } = mockFetch([
      { method: "POST", match: `${PDS}/xrpc/com.atproto.server.createSession`, reply: () => session() },
      { method: "POST", match: `${PDS}/xrpc/com.atproto.repo.uploadBlob`, reply: () => ({ json: { blob: { ref: "b" } } }) },
      { method: "POST", match: `${PDS}/xrpc/com.atproto.repo.createRecord`, reply: () => ({ json: { uri: "at://x/app.bsky.feed.post/1" } }) },
    ]);
    const photo = fakeMedia(config, { kind: "image", size: 1_500_000 });
    const ctx = makeCtx(bluesky, { config, credentials: { identifier: "me", appPassword: "p", service: PDS }, input: { media: [photo] } });
    const spy = vi.spyOn(ctx.media, "jpegVariant");
    await bluesky.publish(ctx);
    expect(spy).not.toHaveBeenCalled(); // 1.5 MB JPEG goes up as-is
    expect((calls[1].body as Buffer).length).toBe(1_500_000);
  });
});

describe("connection checks", () => {
  it("reports what each account can do without posting", async () => {
    mockFetch([
      { method: "GET", match: `${G}/page-1`, reply: () => ({ json: { id: "page-1", name: "Lotus Studio" } }) },
      { method: "GET", match: "https://api.x.com/2/users/me", reply: () => ({ json: { data: { username: "lotus" } } }) },
    ]);
    const base = { config };
    expect(await facebook.checkConnection({ ...base, account: { id: "a", platform: "facebook", externalId: "page-1", name: "", username: null, meta: {} }, credentials: async () => ({ pageAccessToken: "T" }) })).toBe(
      'Connected to the Page "Lotus Studio".',
    );
    expect(await x.checkConnection({ ...base, account: { id: "a", platform: "x", externalId: "1", name: "", username: null, meta: {} }, credentials: async () => ({ accessToken: "T" }) })).toBe(
      "Can post as @lotus.",
    );
  });
});

