import { beforeEach, describe, expect, it } from "vitest";
import { ApiError, AuthError, UserError } from "../src/http.js";
import { bluesky, clearBlueskySessions } from "../src/platforms/bluesky.js";
import { facebook } from "../src/platforms/facebook.js";
import { instagram } from "../src/platforms/instagram.js";
import { linkedin, resetLinkedInVersionCache } from "../src/platforms/linkedin.js";
import { threads } from "../src/platforms/threads.js";
import { tiktokPlatform } from "../src/platforms/tiktok.js";
import { x } from "../src/platforms/x.js";
import { youtube } from "../src/platforms/youtube.js";
import { fakeMedia, form, json, makeCtx, mockFetch, testConfig } from "./helpers.js";

const G = "https://graph.facebook.com/v26.0";

beforeEach(() => clearBlueskySessions());

describe("Facebook", () => {
  const config = testConfig();

  it("posts text to the Page feed", async () => {
    const { calls } = mockFetch([
      { method: "POST", match: `${G}/page-1/feed`, reply: () => ({ json: { id: "page-1_post-9" } }) },
      { method: "GET", match: `${G}/page-1_post-9`, reply: () => ({ json: { permalink_url: "https://www.facebook.com/page/posts/9" } }) },
    ]);
    const ctx = makeCtx(facebook, {
      config,
      account: { externalId: "page-1" },
      credentials: { pageAccessToken: "PAGE_TOKEN" },
      input: { text: "Hello Facebook" },
    });
    const res = await facebook.publish(ctx);
    expect(res).toEqual({ remoteId: "page-1_post-9", url: "https://www.facebook.com/page/posts/9" });
    expect(form(calls[0])).toEqual({ message: "Hello Facebook", access_token: "PAGE_TOKEN" });
  });

  it("uploads several photos unpublished and attaches them to one post", async () => {
    let photo = 0;
    const { calls } = mockFetch([
      { method: "POST", match: `${G}/page-1/photos`, reply: () => ({ json: { id: `photo-${++photo}` } }) },
      { method: "POST", match: `${G}/page-1/feed`, reply: () => ({ json: { id: "page-1_post-2" } }) },
      { method: "GET", match: G, reply: () => ({ json: { permalink_url: "/page/posts/2" } }) },
    ]);
    const ctx = makeCtx(facebook, {
      config,
      account: { externalId: "page-1" },
      credentials: { pageAccessToken: "T" },
      input: { text: "Album", media: [fakeMedia(config, { kind: "image" }), fakeMedia(config, { kind: "image" })] },
    });
    const res = await facebook.publish(ctx);
    expect(res.url).toBe("https://www.facebook.com/page/posts/2");
    expect(form(calls[0])).toMatchObject({ published: "false", access_token: "T", source: "<file:1000>" });
    expect(form(calls[2])).toEqual({
      message: "Album",
      access_token: "T",
      "attached_media[0]": '{"media_fbid":"photo-1"}',
      "attached_media[1]": '{"media_fbid":"photo-2"}',
    });
  });

  it("publishes a reel in three phases", async () => {
    const { calls } = mockFetch([
      {
        method: "POST",
        match: `${G}/page-1/video_reels`,
        reply: (c) =>
          form(c).upload_phase === "start"
            ? { json: { video_id: "vid-1", upload_url: "https://rupload.facebook.com/video-upload/v26.0/vid-1" } }
            : { json: { success: true } },
      },
      { method: "POST", match: "https://rupload.facebook.com/video-upload/v26.0/vid-1", reply: () => ({ json: { success: true } }) },
      {
        method: "GET",
        match: `${G}/vid-1`,
        reply: (_c, n) => ({
          json: { status: { video_status: n < 2 ? "processing" : "ready", publishing_phase: { status: n < 2 ? "in_progress" : "complete" } } },
        }),
      },
    ]);
    const video = fakeMedia(config, { kind: "video", size: 4096 });
    const ctx = makeCtx(facebook, {
      config,
      account: { externalId: "page-1" },
      credentials: { pageAccessToken: "T" },
      input: { text: "Reel!", media: [video], options: { videoFormat: "reel" } },
    });
    const res = await facebook.publish(ctx);
    expect(res).toEqual({ remoteId: "vid-1", url: "https://www.facebook.com/reel/vid-1" });
    const upload = calls[1];
    expect(upload.headers.get("authorization")).toBe("OAuth T");
    expect(upload.headers.get("offset")).toBe("0");
    expect(upload.headers.get("file_size")).toBe("4096");
    expect(form(calls[2])).toMatchObject({ upload_phase: "finish", video_id: "vid-1", video_state: "PUBLISHED", description: "Reel!" });
  });

  it("maps an expired token to an AuthError", async () => {
    mockFetch([
      {
        match: G,
        reply: () => ({ status: 400, json: { error: { message: "Session has expired", type: "OAuthException", code: 190 } } }),
      },
    ]);
    const ctx = makeCtx(facebook, { config, credentials: { pageAccessToken: "T" }, input: { text: "x" } });
    await expect(facebook.publish(ctx)).rejects.toBeInstanceOf(AuthError);
  });

  it("treats Meta rate limits as retryable", async () => {
    mockFetch([{ match: G, reply: () => ({ status: 400, json: { error: { message: "Application request limit reached", code: 4 } } }) }]);
    const ctx = makeCtx(facebook, { config, credentials: { pageAccessToken: "T" }, input: { text: "x" } });
    const err = await facebook.publish(ctx).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.retryable).toBe(true);
  });
});

describe("Instagram", () => {
  const config = testConfig();
  /** Batched container status: GET /?ids=a,b&fields=status_code,status */
  const statusRoute = (status: (id: string, n: number) => string) => ({
    method: "GET",
    match: `${G}/?ids=`,
    reply: (c: { url: URL }, n: number) => ({
      json: Object.fromEntries(c.url.searchParams.get("ids")!.split(",").map((id) => [id, { id, status_code: status(id, n) }])),
    }),
  });

  it("publishes a photo from its public URL", async () => {
    const { calls } = mockFetch([
      { method: "POST", match: `${G}/ig-1/media_publish`, reply: () => ({ json: { id: "media-77" } }) },
      { method: "POST", match: `${G}/ig-1/media`, reply: () => ({ json: { id: "container-1" } }) },
      statusRoute(() => "FINISHED"),
      { method: "GET", match: `${G}/media-77`, reply: () => ({ json: { permalink: "https://www.instagram.com/p/abc/" } }) },
    ]);
    const photo = fakeMedia(config, { kind: "image" });
    const ctx = makeCtx(instagram, {
      config,
      account: { externalId: "ig-1" },
      credentials: { accessToken: "T" },
      input: { text: "Sunset", media: [photo] },
    });
    const res = await instagram.publish(ctx);
    expect(res).toEqual({ remoteId: "media-77", url: "https://www.instagram.com/p/abc/" });
    const body = form(calls[0]);
    expect(body.caption).toBe("Sunset");
    expect(body.image_url).toMatch(new RegExp(`^https://posts\\.example\\.com/media/[\\w-]+/${photo.file}$`));
    expect(calls[1].url.searchParams.get("ids")).toBe("container-1");
    expect(form(calls[2])).toEqual({ creation_id: "container-1", access_token: "T" });
  });

  it("uploads reels directly with the resumable protocol and waits for processing", async () => {
    const { calls } = mockFetch([
      { method: "POST", match: `${G}/ig-1/media_publish`, reply: () => ({ json: { id: "reel-1" } }) },
      {
        method: "POST",
        match: `${G}/ig-1/media`,
        reply: () => ({ json: { id: "c-9", uri: "https://rupload.facebook.com/ig-api-upload/v26.0/c-9" } }),
      },
      { method: "POST", match: "https://rupload.facebook.com/ig-api-upload/v26.0/c-9", reply: () => ({ json: { success: true } }) },
      statusRoute((_id, n) => (n < 3 ? "IN_PROGRESS" : "FINISHED")),
      { method: "GET", match: `${G}/reel-1`, reply: () => ({ json: { permalink: "https://www.instagram.com/reel/xyz/" } }) },
    ]);
    const video = fakeMedia(config, { kind: "video", size: 2048 });
    const ctx = makeCtx(instagram, {
      config,
      account: { externalId: "ig-1" },
      credentials: { accessToken: "T" },
      input: { text: "Reel caption", media: [video], options: { shareToFeed: false } },
    });
    const res = await instagram.publish(ctx);
    expect(res.url).toBe("https://www.instagram.com/reel/xyz/");
    expect(form(calls[0])).toEqual({
      media_type: "REELS",
      caption: "Reel caption",
      share_to_feed: "false",
      upload_type: "resumable",
      access_token: "T",
    });
    expect(calls[1].headers.get("file_size")).toBe("2048");
    expect(calls[1].headers.get("authorization")).toBe("OAuth T");
    expect(calls.filter((c) => c.url.searchParams.get("ids") === "c-9")).toHaveLength(3);
  });

  it("builds carousels: creates every item, then checks them all in one request", async () => {
    let n = 0;
    const { calls } = mockFetch([
      { method: "POST", match: `${G}/ig-1/media_publish`, reply: () => ({ json: { id: "post-1" } }) },
      { method: "POST", match: `${G}/ig-1/media`, reply: () => ({ json: { id: `c-${++n}` } }) },
      statusRoute(() => "FINISHED"),
      { method: "GET", match: `${G}/post-1`, reply: () => ({ json: { permalink: "https://www.instagram.com/p/car/" } }) },
    ]);
    const ctx = makeCtx(instagram, {
      config,
      account: { externalId: "ig-1" },
      credentials: { accessToken: "T" },
      input: { text: "Carousel", media: [fakeMedia(config, { kind: "image" }), fakeMedia(config, { kind: "image" })] },
    });
    await instagram.publish(ctx);
    const creates = calls.filter((c) => c.method === "POST" && c.url.pathname.endsWith("/ig-1/media")).map(form);
    expect(creates[0].is_carousel_item).toBe("true");
    expect(creates[1].is_carousel_item).toBe("true");
    expect(creates[2]).toMatchObject({ media_type: "CAROUSEL", children: "c-1,c-2", caption: "Carousel" });
    const polls = calls.filter((c) => c.url.searchParams.has("ids")).map((c) => c.url.searchParams.get("ids"));
    expect(polls).toEqual(["c-1,c-2", "c-3"]);
  });

  it("fails clearly when Instagram can't process the media", async () => {
    mockFetch([
      { method: "POST", match: `${G}/ig-1/media`, reply: () => ({ json: { id: "c-1" } }) },
      {
        method: "GET",
        match: `${G}/?ids=`,
        reply: () => ({ json: { "c-1": { id: "c-1", status_code: "ERROR", status: "Error: unsupported aspect ratio" } } }),
      },
    ]);
    const ctx = makeCtx(instagram, {
      config,
      account: { externalId: "ig-1" },
      credentials: { accessToken: "T" },
      input: { text: "", media: [fakeMedia(config, { kind: "image" })] },
    });
    await expect(instagram.publish(ctx)).rejects.toThrow(/unsupported aspect ratio/);
  });
});

describe("Threads", () => {
  it("publishes a text post", async () => {
    const T = "https://graph.threads.net/v1.0";
    const { calls } = mockFetch([
      { method: "POST", match: `${T}/th-1/threads_publish`, reply: () => ({ json: { id: "post-5" } }) },
      { method: "POST", match: `${T}/th-1/threads`, reply: () => ({ json: { id: "c-1" } }) },
      { method: "GET", match: `${T}/c-1`, reply: () => ({ json: { status: "FINISHED" } }) },
      { method: "GET", match: `${T}/post-5`, reply: () => ({ json: { permalink: "https://www.threads.net/@me/post/abc" } }) },
    ]);
    const ctx = makeCtx(threads, { config: testConfig(), account: { externalId: "th-1" }, credentials: { accessToken: "T" }, input: { text: "Hi Threads" } });
    const res = await threads.publish(ctx);
    expect(res.url).toBe("https://www.threads.net/@me/post/abc");
    expect(form(calls[0])).toEqual({ media_type: "TEXT", text: "Hi Threads", access_token: "T" });
  });
});

describe("TikTok", () => {
  const config = testConfig();
  const API = "https://open.tiktokapis.com/v2";
  const ok = (data: unknown) => ({ json: { data, error: { code: "ok", message: "", log_id: "1" } } });
  const creatorInfo = ok({
    creator_username: "lotus",
    creator_nickname: "Lotus",
    privacy_level_options: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"],
    comment_disabled: false,
    duet_disabled: true,
    stitch_disabled: false,
    max_video_post_duration_sec: 600,
  });

  it("direct-posts a video: creator info → init → chunk upload → status", async () => {
    const { calls } = mockFetch([
      { method: "POST", match: `${API}/post/publish/creator_info/query/`, reply: () => creatorInfo },
      {
        method: "POST",
        match: `${API}/post/publish/video/init/`,
        reply: () => ok({ publish_id: "v_pub_1", upload_url: "https://open-upload.tiktokapis.com/video/?upload_id=1" }),
      },
      { method: "PUT", match: "https://open-upload.tiktokapis.com/video/", reply: () => ({ status: 201, text: "" }) },
      {
        method: "POST",
        match: `${API}/post/publish/status/fetch/`,
        reply: (_c, n) =>
          n < 2 ? ok({ status: "PROCESSING_UPLOAD" }) : ok({ status: "PUBLISH_COMPLETE", publicaly_available_post_id: [7311] }),
      },
    ]);
    const video = fakeMedia(config, { kind: "video", size: 5000 });
    const ctx = makeCtx(tiktokPlatform, {
      config,
      credentials: { accessToken: "TT" },
      input: { text: "Dance #fyp", media: [video], options: { privacyLevel: "PUBLIC_TO_EVERYONE", allowStitch: true } },
    });
    const res = await tiktokPlatform.publish(ctx);
    expect(res).toMatchObject({ remoteId: "7311", url: "https://www.tiktok.com/@lotus/video/7311" });

    const init = json(calls[1]);
    expect(init.post_info).toEqual({
      title: "Dance #fyp",
      privacy_level: "PUBLIC_TO_EVERYONE",
      disable_comment: true, // interactions are off unless turned on
      disable_duet: true,
      disable_stitch: false, // turned on above, and allowed by the creator's settings
      brand_organic_toggle: false,
      brand_content_toggle: false,
      is_aigc: false,
    });
    expect(init.source_info).toEqual({ source: "FILE_UPLOAD", video_size: 5000, chunk_size: 5000, total_chunk_count: 1 });
    expect(calls[1].headers.get("authorization")).toBe("Bearer TT");
    expect(calls[2].headers.get("content-range")).toBe("bytes 0-4999/5000");
    expect(json(calls[3])).toEqual({ publish_id: "v_pub_1" });
  });

  it("refuses privacy levels the account doesn't offer", async () => {
    mockFetch([
      {
        method: "POST",
        match: `${API}/post/publish/creator_info/query/`,
        reply: () => ok({ creator_username: "lotus", privacy_level_options: ["SELF_ONLY"] }),
      },
    ]);
    const ctx = makeCtx(tiktokPlatform, {
      config,
      credentials: { accessToken: "TT" },
      input: { text: "x", media: [fakeMedia(config, { kind: "video" })], options: { privacyLevel: "PUBLIC_TO_EVERYONE" } },
    });
    await expect(tiktokPlatform.publish(ctx)).rejects.toBeInstanceOf(UserError);
  });

  it("explains the unaudited-app restriction", async () => {
    mockFetch([
      { method: "POST", match: `${API}/post/publish/creator_info/query/`, reply: () => creatorInfo },
      {
        method: "POST",
        match: `${API}/post/publish/video/init/`,
        reply: () => ({
          status: 403,
          json: { error: { code: "unaudited_client_can_only_post_to_private_accounts", message: "...", log_id: "x" } },
        }),
      },
    ]);
    const ctx = makeCtx(tiktokPlatform, {
      config,
      credentials: { accessToken: "TT" },
      input: { text: "x", media: [fakeMedia(config, { kind: "video" })], options: { privacyLevel: "PUBLIC_TO_EVERYONE" } },
    });
    await expect(tiktokPlatform.publish(ctx)).rejects.toThrow(/hasn't passed TikTok's audit yet.*set your TikTok account to Private/);
  });

  it("can send the video to the TikTok inbox instead", async () => {
    const { calls } = mockFetch([
      { method: "POST", match: `${API}/post/publish/inbox/video/init/`, reply: () => ok({ publish_id: "p2", upload_url: "https://up.example/x" }) },
      { method: "PUT", match: "https://up.example/x", reply: () => ({ status: 201, text: "" }) },
      { method: "POST", match: `${API}/post/publish/status/fetch/`, reply: () => ok({ status: "SEND_TO_USER_INBOX" }) },
    ]);
    const ctx = makeCtx(tiktokPlatform, {
      config,
      credentials: { accessToken: "TT" },
      input: { text: "x", media: [fakeMedia(config, { kind: "video" })], options: { mode: "inbox" } },
    });
    const res = await tiktokPlatform.publish(ctx);
    expect(res.note).toMatch(/inbox/);
    expect(json(calls[0])).toEqual({ source_info: { source: "FILE_UPLOAD", video_size: 1000, chunk_size: 1000, total_chunk_count: 1 } });
  });
});

describe("LinkedIn", () => {
  const config = testConfig();
  const REST = "https://api.linkedin.com/rest";
  beforeEach(() => resetLinkedInVersionCache());

  it("creates a text post with escaped commentary", async () => {
    const { calls } = mockFetch([
      { method: "POST", match: `${REST}/posts`, reply: () => ({ status: 201, text: "", headers: { "x-restli-id": "urn:li:share:123" } }) },
    ]);
    const ctx = makeCtx(linkedin, {
      config,
      account: { externalId: "urn:li:person:abc" },
      credentials: { accessToken: "LI" },
      input: { text: "Big news (finally)! #launch" },
    });
    const res = await linkedin.publish(ctx);
    expect(res).toEqual({ remoteId: "urn:li:share:123", url: "https://www.linkedin.com/feed/update/urn:li:share:123/" });
    const body = json(calls[0]);
    expect(body).toMatchObject({
      author: "urn:li:person:abc",
      commentary: "Big news \\(finally\\)! {hashtag|\\#|launch}",
      visibility: "PUBLIC",
      lifecycleState: "PUBLISHED",
    });
    expect(calls[0].headers.get("x-restli-protocol-version")).toBe("2.0.0");
    expect(calls[0].headers.get("linkedin-version")).toMatch(/^\d{6}$/);
  });

  it("falls back to an older API version when LinkedIn says the version isn't active", async () => {
    const versions: string[] = [];
    mockFetch([
      {
        method: "POST",
        match: `${REST}/posts`,
        reply: (c, n) => {
          versions.push(c.headers.get("linkedin-version")!);
          return n < 3
            ? { status: 426, json: { status: 426, code: "NONEXISTENT_VERSION", message: "Requested version is not active" } }
            : { status: 201, text: "", headers: { "x-restli-id": "urn:li:share:9" } };
        },
      },
    ]);
    const ctx = makeCtx(linkedin, { config, account: { externalId: "urn:li:person:abc" }, credentials: { accessToken: "LI" }, input: { text: "hi" } });
    await linkedin.publish(ctx);
    expect(versions).toHaveLength(3);
    expect(new Set(versions).size).toBe(3);
    expect(Number(versions[0])).toBeGreaterThan(Number(versions[2]));
  });

  it("uploads a video in parts, finalizes with ETags, and attaches it", async () => {
    const { calls } = mockFetch([
      {
        method: "POST",
        match: `${REST}/videos?action=initializeUpload`,
        reply: () => ({
          json: {
            value: {
              video: "urn:li:video:V1",
              uploadToken: "tok",
              uploadInstructions: [
                { uploadUrl: "https://upload.linkedin.example/part1", firstByte: 0, lastByte: 599 },
                { uploadUrl: "https://upload.linkedin.example/part2", firstByte: 600, lastByte: 999 },
              ],
            },
          },
        }),
      },
      { method: "PUT", match: "https://upload.linkedin.example/", reply: (c) => ({ text: "", headers: { etag: `etag-${c.url.pathname.slice(-1)}` } }) },
      { method: "POST", match: `${REST}/videos?action=finalizeUpload`, reply: () => ({ text: "" }) },
      { method: "GET", match: `${REST}/videos/`, reply: (_c, n) => ({ json: { status: n < 2 ? "PROCESSING" : "AVAILABLE" } }) },
      { method: "POST", match: `${REST}/posts`, reply: () => ({ status: 201, text: "", headers: { "x-restli-id": "urn:li:ugcPost:5" } }) },
    ]);
    const ctx = makeCtx(linkedin, {
      config,
      account: { externalId: "urn:li:person:abc" },
      credentials: { accessToken: "LI" },
      input: { text: "Watch", title: "My talk", media: [fakeMedia(config, { kind: "video", size: 1000 })] },
    });
    await linkedin.publish(ctx);
    expect(json(calls[0]).initializeUploadRequest).toEqual({
      owner: "urn:li:person:abc",
      fileSizeBytes: 1000,
      uploadCaptions: false,
      uploadThumbnail: false,
    });
    expect((calls[1].body as Buffer).length).toBe(600);
    expect((calls[2].body as Buffer).length).toBe(400);
    expect(json(calls[3]).finalizeUploadRequest).toEqual({ video: "urn:li:video:V1", uploadToken: "tok", uploadedPartIds: ["etag-1", "etag-2"] });
    expect(calls[4].url.pathname).toBe(`/rest/videos/${encodeURIComponent("urn:li:video:V1")}`);
    expect(json(calls.at(-1)!).content).toEqual({ media: { id: "urn:li:video:V1", title: "My talk" } });
  });
});

describe("YouTube", () => {
  it("does a resumable upload and links Shorts for vertical videos", async () => {
    const config = testConfig();
    const { calls } = mockFetch([
      {
        method: "POST",
        match: "https://www.googleapis.com/upload/youtube/v3/videos",
        reply: () => ({ text: "", headers: { location: "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=U1" } }),
      },
      {
        method: "PUT",
        match: "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=U1",
        reply: () => ({ json: { id: "yt123", status: { privacyStatus: "public" } } }),
      },
    ]);
    const ctx = makeCtx(youtube, {
      config,
      credentials: { accessToken: "YT", refreshToken: "R" },
      input: {
        text: "Daily practice <3",
        title: null,
        media: [fakeMedia(config, { kind: "video", width: 1080, height: 1920, duration: 45, size: 3000 })],
        options: { privacyStatus: "unlisted", tags: "#calm, breath ", madeForKids: false },
      },
    });
    const res = await youtube.publish(ctx);
    expect(res.url).toBe("https://www.youtube.com/shorts/yt123");
    const meta = json(calls[0]);
    expect(meta.snippet).toEqual({ title: "Daily practice 3", description: "Daily practice 3", tags: ["calm", "breath"], categoryId: "22" });
    expect(meta.status).toEqual({ privacyStatus: "unlisted", selfDeclaredMadeForKids: false, containsSyntheticMedia: false });
    expect(calls[0].url.searchParams.get("uploadType")).toBe("resumable");
    expect(calls[0].headers.get("x-upload-content-length")).toBe("3000");
    expect(calls[1].headers.get("content-range")).toBe("bytes 0-2999/3000");
    expect(res.note).toMatch(/YouTube set the video to "public"/);
  });
});

describe("X", () => {
  it("uploads images in chunks and posts them", async () => {
    const config = testConfig();
    const A = "https://api.x.com/2";
    const { calls } = mockFetch([
      { method: "POST", match: `${A}/media/upload/initialize`, reply: () => ({ json: { data: { id: "m1", media_key: "3_m1" } } }) },
      { method: "POST", match: `${A}/media/upload/m1/append`, reply: () => ({ status: 204 }) },
      { method: "POST", match: `${A}/media/upload/m1/finalize`, reply: () => ({ json: { data: { id: "m1" } } }) },
      { method: "POST", match: `${A}/tweets`, reply: () => ({ status: 201, json: { data: { id: "t9", text: "hi" } } }) },
    ]);
    const ctx = makeCtx(x, {
      config,
      account: { username: "lotus" },
      credentials: { accessToken: "XT" },
      input: { text: "hi", media: [fakeMedia(config, { kind: "image", size: 1234 })] },
    });
    const res = await x.publish(ctx);
    expect(res).toEqual({ remoteId: "t9", url: "https://x.com/lotus/status/t9" });
    expect(json(calls[0])).toEqual({ media_type: "image/jpeg", total_bytes: 1234, media_category: "tweet_image" });
    expect(form(calls[1])).toEqual({ segment_index: "0", media: "<file:1234>" });
    expect(json(calls[3])).toEqual({ text: "hi", media: { media_ids: ["m1"] } });
  });

  it("waits for video processing", async () => {
    const config = testConfig();
    const A = "https://api.x.com/2";
    mockFetch([
      { method: "POST", match: `${A}/media/upload/initialize`, reply: () => ({ json: { data: { id: "v1" } } }) },
      { method: "POST", match: `${A}/media/upload/v1/append`, reply: () => ({ status: 204 }) },
      {
        method: "POST",
        match: `${A}/media/upload/v1/finalize`,
        reply: () => ({ json: { data: { id: "v1", processing_info: { state: "pending", check_after_secs: 1 } } } }),
      },
      {
        method: "GET",
        match: `${A}/media/upload?media_id=v1&command=STATUS`,
        reply: (_c, n) => ({ json: { data: { processing_info: { state: n < 2 ? "in_progress" : "succeeded" } } } }),
      },
      { method: "POST", match: `${A}/tweets`, reply: () => ({ status: 201, json: { data: { id: "t1" } } }) },
    ]);
    const ctx = makeCtx(x, { config, credentials: { accessToken: "XT" }, input: { text: "", media: [fakeMedia(config, { kind: "video" })] } });
    expect((await x.publish(ctx)).remoteId).toBe("t1");
  });
});

describe("Bluesky", () => {
  const config = testConfig();
  const PDS = "https://morel.us-east.host.bsky.network";
  const session = {
    did: "did:plc:me",
    handle: "me.bsky.social",
    accessJwt: "JWT",
    didDoc: { service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: PDS }] },
  };

  it("signs in, uploads images and creates the post with facets", async () => {
    const { calls } = mockFetch([
      { method: "POST", match: "https://bsky.social/xrpc/com.atproto.server.createSession", reply: () => ({ json: session }) },
      { method: "POST", match: `${PDS}/xrpc/com.atproto.repo.uploadBlob`, reply: () => ({ json: { blob: { $type: "blob", ref: { $link: "bafy" }, mimeType: "image/jpeg", size: 1000 } } }) },
      { method: "POST", match: `${PDS}/xrpc/com.atproto.repo.createRecord`, reply: () => ({ json: { uri: "at://did:plc:me/app.bsky.feed.post/3kabc", cid: "c" } }) },
    ]);
    const ctx = makeCtx(bluesky, {
      config,
      credentials: { identifier: "me.bsky.social", appPassword: "app-pass", service: "https://bsky.social" },
      input: { text: "Calm #morning", media: [fakeMedia(config, { kind: "image", width: 800, height: 600 })] },
    });
    const res = await bluesky.publish(ctx);
    expect(res.url).toBe("https://bsky.app/profile/me.bsky.social/post/3kabc");
    expect(json(calls[0])).toEqual({ identifier: "me.bsky.social", password: "app-pass" });
    expect(calls[1].headers.get("authorization")).toBe("Bearer JWT");
    const record = json(calls[2]).record;
    expect(record.text).toBe("Calm #morning");
    expect(record.facets[0].features[0]).toEqual({ $type: "app.bsky.richtext.facet#tag", tag: "morning" });
    expect(record.embed).toEqual({
      $type: "app.bsky.embed.images",
      images: [{ alt: "", image: expect.objectContaining({ $type: "blob" }), aspectRatio: { width: 800, height: 600 } }],
    });
  });

  it("uploads video through the video service with a service token", async () => {
    const { calls } = mockFetch([
      { method: "POST", match: "https://bsky.social/xrpc/com.atproto.server.createSession", reply: () => ({ json: session }) },
      { method: "GET", match: `${PDS}/xrpc/com.atproto.server.getServiceAuth`, reply: () => ({ json: { token: "SVC" } }) },
      { method: "POST", match: "https://video.bsky.app/xrpc/app.bsky.video.uploadVideo", reply: () => ({ json: { jobId: "job1", state: "JOB_STATE_CREATED" } }) },
      {
        method: "GET",
        match: "https://video.bsky.app/xrpc/app.bsky.video.getJobStatus",
        reply: (_c, n) => ({ json: { jobStatus: n < 2 ? { jobId: "job1", state: "JOB_STATE_ENCODING" } : { jobId: "job1", state: "JOB_STATE_COMPLETED", blob: { ref: "vid" } } } }),
      },
      { method: "POST", match: `${PDS}/xrpc/com.atproto.repo.createRecord`, reply: () => ({ json: { uri: "at://did:plc:me/app.bsky.feed.post/3kv", cid: "c" } }) },
    ]);
    const ctx = makeCtx(bluesky, {
      config,
      credentials: { identifier: "me", appPassword: "p", service: "https://bsky.social" },
      input: { text: "clip", media: [fakeMedia(config, { kind: "video" })] },
    });
    await bluesky.publish(ctx);
    expect(calls[1].url.searchParams.get("aud")).toBe("did:web:morel.us-east.host.bsky.network");
    expect(calls[1].url.searchParams.get("lxm")).toBe("com.atproto.repo.uploadBlob");
    expect(calls[2].headers.get("authorization")).toBe("Bearer SVC");
    expect(calls[2].url.searchParams.get("did")).toBe("did:plc:me");
    expect(json(calls.at(-1)!).record.embed).toEqual({ $type: "app.bsky.embed.video", video: { ref: "vid" }, aspectRatio: { width: 1080, height: 1920 } });
  });

  it("reports a wrong app password as an auth problem", async () => {
    mockFetch([
      {
        method: "POST",
        match: "https://bsky.social/xrpc/com.atproto.server.createSession",
        reply: () => ({ status: 401, json: { error: "AuthenticationRequired", message: "Invalid identifier or password" } }),
      },
    ]);
    const ctx = makeCtx(bluesky, { config, credentials: { identifier: "me", appPassword: "bad", service: "https://bsky.social" }, input: { text: "x" } });
    await expect(bluesky.publish(ctx)).rejects.toThrow(/Invalid identifier or password/);
  });
});
