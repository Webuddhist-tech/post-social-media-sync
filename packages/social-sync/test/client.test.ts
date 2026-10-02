import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { postSyncExpress } from "../src/adapters/express.js";
import { createPostSyncClient, PostSyncClientError, type PostSyncClientOptions } from "../src/client/index.js";
import { createPostSync, type PostSync } from "../src/index.js";
import { clearBlueskySessions } from "../src/platforms/bluesky.js";
import { sqliteStorage } from "../src/storage/sqlite.js";
import { mockFetch, tempDir, TEST_SECRET, type Route } from "./helpers.js";

// mockFetch replaces the global fetch for the platform APIs; the client keeps talking to the test server with this.
const realFetch = globalThis.fetch;

// 1x1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const PDS = "https://pds.example.net";

function blueskyRoutes(): Route[] {
  return [
    {
      method: "POST",
      match: "https://bsky.social/xrpc/com.atproto.server.createSession",
      reply: (c) => {
        const id = JSON.parse(String(c.body)).identifier as string;
        return {
          json: {
            did: `did:plc:${id.split(".")[0]}`,
            handle: id,
            accessJwt: "JWT",
            refreshJwt: "RJWT",
            didDoc: { service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: PDS }] },
          },
        };
      },
    },
    { method: "GET", match: `${PDS}/xrpc/app.bsky.actor.getProfile`, reply: () => ({ json: { displayName: "Alice" } }) },
    { method: "GET", match: `${PDS}/xrpc/com.atproto.server.getSession`, reply: () => ({ json: { handle: "alice.bsky.social", active: true } }) },
  ];
}

function metaRoutes(): Route[] {
  const granted = ["pages_show_list", "pages_manage_posts", "instagram_basic", "instagram_content_publish"];
  return [
    { method: "GET", match: "https://graph.facebook.com/v26.0/oauth/access_token", reply: () => ({ json: { access_token: "user-token" } }) },
    {
      method: "GET",
      match: "https://graph.facebook.com/v26.0/me/permissions",
      reply: () => ({ json: { data: granted.map((permission) => ({ permission, status: "granted" })) } }),
    },
    {
      method: "GET",
      match: "https://graph.facebook.com/v26.0/me/accounts",
      reply: () => ({ json: { data: [{ id: "page-1", name: "My Page", access_token: "page-token", tasks: ["CREATE_CONTENT"] }] } }),
    },
  ];
}

/** Resolves to the rejection of `promise` (fails the test if it resolves). */
async function rejection(promise: Promise<unknown>): Promise<PostSyncClientError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(PostSyncClientError);
    return err as PostSyncClientError;
  }
  throw new Error("expected the call to fail");
}

/** Minimal browser XMLHttpRequest that sends through the real fetch and reports upload progress. */
class FakeXHR {
  static last: FakeXHR | null = null;
  /** Never finish sending (to test aborting). */
  static hold = false;
  upload: { onprogress?: (e: { lengthComputable: boolean; loaded: number; total: number }) => void } = {};
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  withCredentials = false;
  status = 0;
  responseText = "";
  method = "";
  url = "";
  headers: Record<string, string> = {};
  sent = false;

  constructor() {
    FakeXHR.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(key: string, value: string) {
    this.headers[key] = value;
  }
  abort() {
    this.onabort?.();
  }
  send(body: FormData) {
    this.sent = true;
    if (FakeXHR.hold) return;
    this.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 });
    realFetch(this.url, { method: this.method, headers: this.headers, body }).then(
      async (res) => {
        this.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 });
        this.status = res.status;
        this.responseText = await res.text();
        this.onload?.();
      },
      () => this.onerror?.(),
    );
  }
}

describe("client SDK", () => {
  let sync: PostSync;
  let server: http.Server;
  let base: string;
  /** Alice's client: async headers function, trailing slash in baseUrl, real fetch (the global one may be mocked). */
  let alice: ReturnType<typeof createPostSyncClient>;
  const client = (options: Partial<PostSyncClientOptions> = {}) =>
    createPostSyncClient({ baseUrl: `${base}/social/`, headers: async () => ({ "x-user": "alice" }), fetch: realFetch, ...options });

  beforeEach(async () => {
    clearBlueskySessions();
    FakeXHR.last = null;
    FakeXHR.hold = false;
    // A host Express app with its own JSON parser in front, like most backends.
    let social: express.RequestHandler = (_req, _res, next) => next();
    const app = express();
    app.use(express.json());
    app.use("/social", (req, res, next) => social(req, res, next));
    app.get("/broken/platforms", (_req, res) => {
      res.status(502).type("html").send("<h1>Bad gateway</h1>");
    });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    sync = await createPostSync({
      secret: TEST_SECRET,
      publicUrl: `${base}/social`,
      storage: sqliteStorage(":memory:"),
      mediaDir: tempDir(),
      logger: false,
      worker: { autoStart: false },
      sleep: async () => {},
      platforms: { meta: { appId: "meta-app", appSecret: "meta-secret" } },
    });
    social = postSyncExpress(sync, { authenticate: (req) => req.headers["x-user"] ?? null });
    alice = client();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
    await sync.close();
  });

  async function connectBluesky() {
    mockFetch(blueskyRoutes());
    const [account] = await alice.connect.withCredentials("bluesky", { identifier: "alice.bsky.social", appPassword: "app-pass" });
    return account;
  }

  const pause = () => new Promise((resolve) => setTimeout(resolve, 5));

  it("describes the platforms", async () => {
    const description = await alice.platforms();
    expect(description.publicUrl).toBe(`${base}/social`);
    const byId = Object.fromEntries(description.connectors.map((c) => [c.id, c]));
    expect(byId.meta).toMatchObject({ kind: "oauth", configured: true, redirectUri: `${base}/social/oauth/meta/callback` });
    expect(byId.tiktok.configured).toBe(false);
    expect(byId.bluesky.kind).toBe("credentials");
    expect(byId.bluesky.credentialFields?.map((f) => f.key)).toEqual(expect.arrayContaining(["identifier", "appPassword"]));
    expect(description.platforms.map((p) => p.id)).toContain("instagram");
  });

  it("builds URLs from baseUrl and sends the headers from an async function", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const headers = vi.fn(async () => ({ "x-user": "alice", "x-extra": "1" }));
    const spy = client({
      headers,
      credentials: "include",
      fetch: (input, init) => {
        seen.push({ url: String(input), init });
        return realFetch(input, init);
      },
    });
    expect(await spy.accounts.list()).toEqual([]);
    await spy.posts.list({ limit: 5 });
    expect(seen.map((s) => s.url)).toEqual([`${base}/social/accounts`, `${base}/social/posts?limit=5`]);
    expect(seen[0].init?.credentials).toBe("include");
    expect(seen[0].init?.headers).toEqual({ "x-user": "alice", "x-extra": "1" });
    expect(headers).toHaveBeenCalledTimes(2);

    // Default fetch and static headers.
    const plain = createPostSyncClient({ baseUrl: `${base}/social`, headers: { "x-user": "bob" } });
    expect(await plain.accounts.list()).toEqual([]);
  });

  it("lists, gets, checks and removes accounts", async () => {
    const account = await connectBluesky();
    expect(account).toMatchObject({ ownerId: "alice", platform: "bluesky", connector: "bluesky", username: "alice.bsky.social", status: "active" });

    expect((await alice.accounts.list()).map((a) => a.id)).toEqual([account.id]);
    expect((await alice.accounts.get(account.id)).name).toBe("Alice");
    expect(await alice.accounts.check(account.id)).toEqual({ ok: true, detail: "Can post as @alice.bsky.social." });

    // Other owners don't see it.
    const bob = client({ headers: { "x-user": "bob" } });
    expect(await bob.accounts.list()).toEqual([]);
    const notFound = await rejection(bob.accounts.get(account.id));
    expect(notFound.status).toBe(404);
    expect(notFound.message).toBe("Account not found.");
    expect((await rejection(bob.accounts.remove(account.id))).status).toBe(404);

    expect(await alice.accounts.remove(account.id)).toBeUndefined();
    expect(await alice.accounts.list()).toEqual([]);
  });

  it("reports failed credential logins", async () => {
    mockFetch([
      {
        method: "POST",
        match: "https://bsky.social/xrpc/com.atproto.server.createSession",
        reply: () => ({ status: 401, json: { error: "AuthenticationRequired", message: "Invalid identifier or password" } }),
      },
    ]);
    const err = await rejection(alice.connect.withCredentials("bluesky", { identifier: "alice.bsky.social", appPassword: "wrong" }));
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/Invalid identifier or password/);
    expect((await rejection(alice.connect.withCredentials("bluesky", {}))).message).toMatch(/handle and an app password/);
  });

  it("starts OAuth logins and reads the result", async () => {
    const { url } = await alice.connect.start("meta", { returnTo: "/settings" });
    const login = new URL(url);
    expect(login.origin + login.pathname).toBe("https://www.facebook.com/v26.0/dialog/oauth");
    expect(login.searchParams.get("redirect_uri")).toBe(`${base}/social/oauth/meta/callback`);

    // The platform sends the browser back to the callback.
    mockFetch(metaRoutes());
    const callback = `${base}/social/oauth/meta/callback?code=c0de&state=${login.searchParams.get("state")}`;
    const back = await realFetch(callback, { redirect: "manual" });
    expect(back.status).toBe(302);
    const page = new URL(back.headers.get("location")!);
    expect(page.origin + page.pathname).toBe(`${base}/settings`);
    expect(alice.connect.parseResult(page.search)).toEqual({ status: "connected", connector: "Facebook & Instagram", count: 1, error: undefined });
    expect((await alice.accounts.list()).map((a) => a.platform)).toEqual(["facebook"]);

    const replay = new URL((await realFetch(callback, { redirect: "manual" })).headers.get("location")!);
    const failed = alice.connect.parseResult(replay.search);
    expect(failed).toMatchObject({ status: "error", connector: "Facebook & Instagram", count: undefined });
    expect(failed?.error).toMatch(/expired or was already used/);

    expect(alice.connect.parseResult("?tab=accounts")).toBeNull();
    expect(alice.connect.parseResult("")).toBeNull();

    expect((await rejection(alice.connect.start("nope"))).status).toBe(400);
    expect((await rejection(alice.connect.start("meta", { returnTo: "https://evil.example/" }))).status).toBe(400);
    expect((await rejection(alice.connect.start("tiktok"))).message).toMatch(/isn't set up/);
  });

  it("builds the GET connect URL for cookie logins", async () => {
    expect(alice.connect.url("meta")).toBe(`${base}/social/connect/meta`);
    const url = alice.connect.url("meta", { returnTo: "/settings?tab=1" });
    expect(url).toBe(`${base}/social/connect/meta?returnTo=%2Fsettings%3Ftab%3D1`);

    const res = await realFetch(url, { redirect: "manual", headers: { "x-user": "alice" } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^https:\/\/www\.facebook\.com\/v26\.0\/dialog\/oauth\?/);
    expect((await realFetch(url, { redirect: "manual" })).status).toBe(401);
  });

  it("uses the page's location in a browser", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { search: "?postsync=error&connector=TikTok&error=Nope", assign });
    expect(alice.connect.parseResult()).toEqual({ status: "error", connector: "TikTok", count: undefined, error: "Nope" });
    await alice.connect.redirect("meta", { returnTo: "/back" });
    expect(assign).toHaveBeenCalledOnce();
    expect(assign.mock.calls[0][0]).toMatch(/^https:\/\/www\.facebook\.com\//);
  });

  it("uploads, gets and removes media", async () => {
    const progress: number[] = [];
    const [media] = await alice.media.upload(new File([PNG], "dot.png", { type: "image/png" }), { onProgress: (f) => progress.push(f) });
    expect(progress).toEqual([1]);
    expect(media).toMatchObject({ ownerId: "alice", filename: "dot.png", kind: "image", mime: "image/png", size: PNG.length });

    // The signed URL is public and points at this server.
    const file = await realFetch(media.url);
    expect(file.status).toBe(200);
    expect(Buffer.from(await file.arrayBuffer()).equals(PNG)).toBe(true);

    const both = await alice.media.upload([new File([PNG], "a.png", { type: "image/png" }), new Blob([PNG], { type: "image/png" })]);
    expect(both.map((m) => m.filename)).toEqual(["a.png", "upload"]);

    expect(await alice.media.get(media.id)).toEqual(media);
    expect(await alice.media.remove(media.id)).toBeUndefined();
    expect((await rejection(alice.media.get(media.id))).status).toBe(404);
    expect((await realFetch(media.url)).status).toBe(404);

    const unsupported = await rejection(alice.media.upload(new File(["hello"], "notes.txt", { type: "text/plain" })));
    expect(unsupported.status).toBe(400);
    expect(unsupported.message).toMatch(/Unsupported file type/);
    expect((await rejection(alice.media.fromUrl("https://cdn.example.com/a.png"))).status).toBe(403);
  });

  it("reports upload progress through XMLHttpRequest in browsers", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
    const browser = createPostSyncClient({ baseUrl: `${base}/social/`, headers: async () => ({ "x-user": "alice" }), credentials: "include" });
    const progress: number[] = [];
    const [media] = await browser.media.upload(new File([PNG], "dot.png", { type: "image/png" }), { onProgress: (f) => progress.push(f) });
    expect(media.filename).toBe("dot.png");
    expect(progress).toEqual([0.5, 1]);
    expect(FakeXHR.last).toMatchObject({ method: "POST", url: `${base}/social/media`, withCredentials: true, headers: { "x-user": "alice" } });

    const err = await rejection(browser.media.upload(new File(["hello"], "notes.txt", { type: "text/plain" }), { onProgress: () => {} }));
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/Unsupported file type/);

    FakeXHR.hold = true;
    FakeXHR.last = null;
    const controller = new AbortController();
    const pending = browser.media.upload(new File([PNG], "dot.png", { type: "image/png" }), { onProgress: () => {}, signal: controller.signal });
    await vi.waitFor(() => expect(FakeXHR.last?.sent).toBe(true));
    controller.abort();
    expect(await rejection(pending)).toMatchObject({ status: 0, message: "Upload cancelled." });

    // Aborted before the request was even made (e.g. while an async headers() ran): nothing is sent.
    FakeXHR.last = null;
    const early = await rejection(browser.media.upload(new File([PNG], "dot.png"), { onProgress: () => {}, signal: AbortSignal.abort() }));
    expect(early.message).toBe("Upload cancelled.");
    expect(FakeXHR.last).toBeNull();
  });

  it("validates, creates, lists, gets and removes posts", async () => {
    const account = await connectBluesky();
    const issues = await alice.posts.validate({ text: "Hello", platforms: ["bluesky"] });
    expect(issues).toEqual([{ accountId: account.id, accountName: "Alice", platform: "bluesky", length: 5, errors: [] }]);
    const tooLong = await alice.posts.validate({ text: "x".repeat(301), targets: [{ accountId: account.id }] });
    expect(tooLong[0].errors.length).toBeGreaterThan(0);

    const invalid = await rejection(alice.posts.create({ text: "x".repeat(301), targets: [{ accountId: account.id }] }));
    expect(invalid.status).toBe(400);
    expect(invalid.message).toMatch(/can't take this post/);
    expect(invalid.issues).toHaveLength(1);
    expect(invalid.issues?.[0]).toMatchObject({ accountId: account.id, platform: "bluesky", length: 301 });
    expect(invalid.issues?.[0].errors.length).toBeGreaterThan(0);
    const noTargets = await rejection(alice.posts.create({ text: "hi" }));
    expect(noTargets.status).toBe(400);
    expect(noTargets.issues).toBeUndefined();

    const ids: string[] = [];
    for (const n of [1, 2, 3]) {
      const post = await alice.posts.create({ text: `Post ${n}`, platforms: ["bluesky"] });
      expect(post.targets).toMatchObject([{ accountId: account.id, status: "queued" }]);
      ids.push(post.id);
      await pause(); // distinct creation times for the pagination cursor
    }

    const first = await alice.posts.list({ limit: 2 });
    expect(first.posts.map((p) => p.text)).toEqual(["Post 3", "Post 2"]);
    expect(typeof first.nextBefore).toBe("number");
    const second = await alice.posts.list({ limit: 2, before: first.nextBefore });
    expect(second.posts.map((p) => p.text)).toEqual(["Post 1"]);
    expect(second.nextBefore).toBeNull();
    expect((await alice.posts.list()).posts).toHaveLength(3);
    expect((await client({ headers: { "x-user": "bob" } }).posts.list()).posts).toEqual([]);

    expect((await alice.posts.get(ids[0])).text).toBe("Post 1");
    expect(await alice.posts.remove(ids[0])).toBeUndefined();
    expect((await rejection(alice.posts.get(ids[0]))).status).toBe(404);
    expect((await rejection(alice.posts.remove(ids[0]))).status).toBe(404);
    expect((await alice.posts.list()).posts.map((p) => p.text)).toEqual(["Post 3", "Post 2"]);
  });

  it("cancels and retries publish jobs", async () => {
    const account = await connectBluesky();
    const post = await alice.posts.create({ text: "Later", platforms: ["bluesky"], scheduledAt: new Date(Date.now() + 3600_000).toISOString() });
    const targetId = post.targets[0].id;

    // An account with queued posts can't be removed.
    const busy = await rejection(alice.accounts.remove(account.id));
    expect(busy.status).toBe(409);
    expect((await rejection(alice.targets.retry(targetId))).status).toBe(409);

    expect(await alice.targets.cancel(targetId)).toBeUndefined();
    expect((await alice.posts.get(post.id)).targets[0].status).toBe("cancelled");
    expect((await rejection(alice.targets.cancel(targetId))).status).toBe(409);

    expect(await alice.targets.retry(targetId)).toBeUndefined();
    expect((await alice.posts.get(post.id)).targets[0].status).toBe("queued");

    // Other owners can't touch it.
    const bob = client({ headers: { "x-user": "bob" } });
    expect((await rejection(bob.targets.cancel(targetId))).status).toBe(409);
    expect((await alice.posts.get(post.id)).targets[0].status).toBe("queued");

    await alice.targets.cancel(targetId);
    await alice.accounts.remove(account.id);
    expect(await alice.accounts.list()).toEqual([]);
  });

  it("turns error responses into PostSyncClientError", async () => {
    const anonymous = createPostSyncClient({ baseUrl: `${base}/social`, fetch: realFetch });
    const unauthorized = await rejection(anonymous.accounts.list());
    expect(unauthorized).toMatchObject({ name: "PostSyncClientError", status: 401, message: "Not logged in." });

    const broken = createPostSyncClient({ baseUrl: `${base}/broken`, fetch: realFetch });
    const gateway = await rejection(broken.platforms());
    expect(gateway.status).toBe(502);
    expect(gateway.message).toBe("Request failed (502)");
    expect(gateway.issues).toBeUndefined();
  });
});
