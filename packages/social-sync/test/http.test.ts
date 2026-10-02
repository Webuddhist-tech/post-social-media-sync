import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { postSyncExpress } from "../src/adapters/express.js";
import { postSyncFastify } from "../src/adapters/fastify.js";
import {
  createHandler,
  createPostSync,
  toNodeHandler,
  type HandlerOptions,
  type PostSync,
  type PostSyncHandler,
  type PostSyncOptions,
} from "../src/index.js";
import { clearBlueskySessions } from "../src/platforms/bluesky.js";
import { sqliteStorage } from "../src/storage/sqlite.js";
import { mockFetch, tempDir, TEST_SECRET, type Route } from "./helpers.js";

// Requests to local test servers always use the real fetch, even while a test mocks the platform APIs.
const realFetch = globalThis.fetch;

const ORIGIN = "https://app.example.com";
const BASE = `${ORIGIN}/social`;
const FB_DIALOG = "https://www.facebook.com/v26.0/dialog/oauth";
// 1x1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const BYTES = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));

async function makeSync(options: Partial<PostSyncOptions> = {}): Promise<PostSync> {
  return createPostSync({
    secret: TEST_SECRET,
    publicUrl: BASE,
    storage: sqliteStorage(":memory:"),
    mediaDir: tempDir(),
    maxUploadMb: 1,
    logger: false,
    worker: { autoStart: false },
    sleep: async () => {},
    platforms: { meta: { appId: "meta-app", appSecret: "meta-secret" } },
    ...options,
  });
}

interface CallInit {
  /** Value of the x-user header (null: none). Default "alice". */
  user?: string | null;
  headers?: Record<string, string>;
  json?: unknown;
  body?: RequestInit["body"];
}

/** Calls the handler with a web Request. `path` is relative to BASE unless it is a full URL. */
function call(handler: PostSyncHandler, method: string, path: string, init: CallInit = {}): Promise<Response> {
  const headers: Record<string, string> = { ...init.headers };
  if (init.user !== null) headers["x-user"] = init.user ?? "alice";
  let body = init.body;
  if (init.json !== undefined) {
    body = JSON.stringify(init.json);
    headers["content-type"] ??= "application/json";
  }
  const url = /^https?:/.test(path) ? path : BASE + path;
  return handler.fetch(new Request(url, { method, headers, body, duplex: "half" } as RequestInit));
}

/** The multipart encoding of a form, split into small chunks that arrive over time like a real upload. */
async function slowMultipart(form: FormData, chunkSize = 64 * 1024): Promise<{ type: string; body: ReadableStream<Uint8Array> }> {
  const encoded = new Request("http://encode.local/", { method: "POST", body: form });
  const type = encoded.headers.get("content-type")!;
  const bytes = new Uint8Array(await encoded.arrayBuffer());
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset >= bytes.length) return controller.close();
      await new Promise((resolve) => setTimeout(resolve, 1));
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
  return { type, body };
}

function pngForm(count = 1): FormData {
  const form = new FormData();
  for (let i = 0; i < count; i++) form.append("file", new Blob([PNG], { type: "image/png" }), `dot${i}.png`);
  return form;
}

function bigForm(bytes: number): FormData {
  const form = new FormData();
  form.append("file", new Blob([Buffer.alloc(bytes, 1)], { type: "image/png" }), "big.png");
  return form;
}

const mediaFiles = (sync: PostSync) => fs.readdirSync(sync.config.mediaDir);

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

function blueskyRoutes(): Route[] {
  const pds = "https://morel.us-east.host.bsky.network";
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
            didDoc: { service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: pds }] },
          },
        };
      },
    },
    { method: "GET", match: `${pds}/xrpc/app.bsky.actor.getProfile`, reply: () => ({ json: { displayName: "Alice" } }) },
  ];
}

const location = (res: Response) => new URL(res.headers.get("location") ?? "");

describe("HTTP handler", () => {
  let sync: PostSync;
  let handler: PostSyncHandler;
  const withOptions = (options: HandlerOptions = {}) =>
    createHandler(sync, { authenticate: (request) => request.headers.get("x-user"), ...options });

  beforeEach(async () => {
    clearBlueskySessions();
    sync = await makeSync();
    handler = withOptions();
  });
  afterEach(async () => sync.close());

  describe("returnTo", () => {
    /** Starts a Meta login with `returnTo`, cancels it at Meta, and returns where the browser is sent back to. */
    async function sentBackTo(h: PostSyncHandler, returnTo: unknown): Promise<string> {
      const started = await call(h, "POST", "/connect/meta", { json: returnTo === undefined ? {} : { returnTo } });
      expect(started.status).toBe(200);
      const state = new URL(((await started.json()) as any).url).searchParams.get("state");
      const back = await call(h, "GET", `/oauth/meta/callback?state=${state}&error=access_denied`, { user: null });
      expect(back.status).toBe(302);
      const u = location(back);
      expect(u.searchParams.get("postsync")).toBe("error");
      return u.origin + u.pathname;
    }

    it("accepts paths on publicUrl's origin and allowed absolute URLs", async () => {
      expect(await sentBackTo(handler, "/settings")).toBe(`${ORIGIN}/settings`);
      expect(await sentBackTo(handler, "/a/b?c=d")).toBe(`${ORIGIN}/a/b`);
      expect(await sentBackTo(handler, undefined)).toBe(`${ORIGIN}/`);
      expect(await sentBackTo(handler, "")).toBe(`${ORIGIN}/`);
      expect(await sentBackTo(handler, `${ORIGIN}/accounts`)).toBe(`${ORIGIN}/accounts`);

      const partner = withOptions({ allowedRedirectOrigins: ["https://partner.example.org"] });
      expect(await sentBackTo(partner, "https://partner.example.org/done")).toBe("https://partner.example.org/done");
      expect(await sentBackTo(partner, "/still-fine")).toBe(`${ORIGIN}/still-fine`);
    });

    it.each([
      "//evil.com",
      "/\\evil.com",
      "/\t/evil.com",
      "/\n/evil.com",
      "/\t\\evil.com",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "https://evil.com/",
      "https://app.example.com.evil.com/",
      "http://app.example.com/",
      "settings",
    ])("rejects %j", async (returnTo) => {
      const res = await call(handler, "POST", "/connect/meta", { json: { returnTo } });
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error).toMatch(/returnTo/);
    });

    it("rejects non-strings and origins that aren't listed", async () => {
      expect((await call(handler, "POST", "/connect/meta", { json: { returnTo: 42 } })).status).toBe(400);
      const partner = withOptions({ allowedRedirectOrigins: ["https://partner.example.org"] });
      const res = await call(partner, "POST", "/connect/meta", { json: { returnTo: "https://other.example.org/" } });
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error).toMatch(/allowedRedirectOrigins/);
      // A JSON body that isn't an object is a client error, not a crash.
      expect((await call(handler, "POST", "/connect/meta", { body: "null", headers: { "content-type": "application/json" } })).status).toBe(200);
      expect((await call(handler, "POST", "/connect/bluesky/credentials", { body: "null", headers: { "content-type": "application/json" } })).status).toBe(400);
    });

    it("validates returnTo on GET /connect too (400, no redirect)", async () => {
      const res = await call(handler, "GET", `/connect/meta?returnTo=${encodeURIComponent("/\t/evil.com")}`);
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
    });
  });

  describe("connecting", () => {
    it("GET /connect/:connector redirects to the platform's login page", async () => {
      const res = await call(handler, "GET", "/connect/meta?returnTo=/settings");
      expect(res.status).toBe(302);
      const u = location(res);
      expect(u.origin + u.pathname).toBe(FB_DIALOG);
      expect(u.searchParams.get("client_id")).toBe("meta-app");
      expect(u.searchParams.get("redirect_uri")).toBe(`${BASE}/oauth/meta/callback`);
      expect(u.searchParams.get("state")).toMatch(/.{16,}/);
      expect((await call(handler, "GET", "/connect/meta", { user: null })).status).toBe(401);
    });

    it("sends the browser back with postsync=error when a platform isn't set up or doesn't exist", async () => {
      for (const connector of ["tiktok", "nope", "bluesky"]) {
        const res = await call(handler, "GET", `/connect/${connector}?returnTo=/settings`);
        expect(res.status).toBe(302);
        const u = location(res);
        expect(u.origin + u.pathname).toBe(`${ORIGIN}/settings`);
        expect(u.searchParams.get("postsync")).toBe("error");
        expect(u.searchParams.get("connector")).toBe(connector);
        expect(u.searchParams.get("error")).toBeTruthy();
      }
      expect(location(await call(handler, "GET", "/connect/tiktok")).toString()).toMatch(/^https:\/\/app\.example\.com\/\?postsync=error/);
      // POST (SPA) answers with an error instead.
      expect((await call(handler, "POST", "/connect/tiktok", { json: {} })).status).toBe(400);
    });

    it("completes an OAuth login once; unknown or replayed states redirect with postsync=error", async () => {
      const fetchMock = mockFetch(metaRoutes());
      const started = await call(handler, "POST", "/connect/meta", { json: { returnTo: "/settings?tab=accounts" } });
      const state = new URL(((await started.json()) as any).url).searchParams.get("state")!;
      const callback = `/oauth/meta/callback?code=the-code&state=${encodeURIComponent(state)}`;

      // The platform redirects the browser here: no login needed (the state says who it is for, and the binding cookie
      // that POST /connect set proves it's the same browser).
      const cookie = started.headers.get("set-cookie")!.split(";")[0];
      const done = await call(handler, "GET", callback, { user: null, headers: { cookie } });
      expect(done.status).toBe(302);
      const u = location(done);
      expect(u.origin + u.pathname).toBe(`${ORIGIN}/settings`);
      expect(Object.fromEntries(u.searchParams)).toEqual({ tab: "accounts", postsync: "connected", connector: "Facebook & Instagram", count: "1" });
      expect((await sync.accounts.list("alice")).map((a) => a.platform)).toEqual(["facebook"]);
      const exchange = fetchMock.calls.find((c) => c.url.pathname.endsWith("/oauth/access_token"))!;
      expect(exchange.url.searchParams.get("code")).toBe("the-code");
      expect(exchange.url.searchParams.get("redirect_uri")).toBe(`${BASE}/oauth/meta/callback`);

      const replay = await call(handler, "GET", callback, { user: null });
      expect(replay.status).toBe(302);
      const r = location(replay);
      expect(r.origin + r.pathname).toBe(`${ORIGIN}/`);
      expect(r.searchParams.get("postsync")).toBe("error");
      expect(r.searchParams.get("error")).toMatch(/expired or was already used/);
      expect(await sync.accounts.list("alice")).toHaveLength(1);

      for (const path of ["/oauth/meta/callback?code=x&state=made-up", "/oauth/meta/callback?code=x", "/oauth/nope/callback?state=x"]) {
        const res = await call(handler, "GET", path, { user: null });
        expect(res.status).toBe(302);
        expect(location(res).searchParams.get("postsync")).toBe("error");
      }
      expect(fetchMock.calls.filter((c) => c.url.pathname.endsWith("/oauth/access_token"))).toHaveLength(2);
    });

    it("uses defaultReturnTo when no returnTo was given", async () => {
      const h = withOptions({ defaultReturnTo: "https://app.example.com/welcome" });
      const res = await call(h, "GET", "/oauth/meta/callback?state=unknown", { user: null });
      expect(location(res).pathname).toBe("/welcome");
    });
  });

  describe("CORS", () => {
    const SPA = "https://spa.example.org";

    it("answers preflights with CORS headers only for listed origins", async () => {
      const h = withOptions({ cors: { origins: [SPA], credentials: true } });
      const preflight = (origin: string) =>
        call(h, "OPTIONS", "/posts", {
          user: null,
          headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type, x-user" },
        });
      const ok = await preflight(SPA);
      expect(ok.status).toBe(204);
      expect(ok.headers.get("access-control-allow-origin")).toBe(SPA);
      expect(ok.headers.get("access-control-allow-credentials")).toBe("true");
      expect(ok.headers.get("access-control-allow-methods")).toContain("POST");
      expect(ok.headers.get("access-control-allow-headers")).toBe("content-type, x-user");
      expect(ok.headers.get("vary")).toBe("Origin");

      const evil = await preflight("https://evil.example");
      expect(evil.headers.get("access-control-allow-origin")).toBeNull();
      expect(evil.headers.get("access-control-allow-credentials")).toBeNull();
    });

    it("adds CORS headers to responses (errors included) for listed origins only", async () => {
      const h = withOptions({ cors: { origins: [SPA] } });
      const ok = await call(h, "GET", "/accounts", { headers: { origin: SPA } });
      expect(ok.status).toBe(200);
      expect(ok.headers.get("access-control-allow-origin")).toBe(SPA);
      expect(ok.headers.get("access-control-allow-credentials")).toBeNull();
      const denied = await call(h, "GET", "/accounts", { user: null, headers: { origin: SPA } });
      expect(denied.status).toBe(401);
      expect(denied.headers.get("access-control-allow-origin")).toBe(SPA);
      expect((await call(h, "GET", "/accounts", { headers: { origin: "https://evil.example" } })).headers.get("access-control-allow-origin")).toBeNull();
      // Listed origins may also write.
      expect((await call(h, "POST", "/connect/meta", { json: {}, headers: { origin: SPA } })).status).toBe(200);
    });

    it("leaves OPTIONS alone without the cors option", async () => {
      const res = await call(handler, "OPTIONS", "/posts", { headers: { origin: SPA } });
      expect(res.status).toBe(404);
      expect(res.headers.get("x-post-sync-unmatched")).toBe("1");
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });
  });

  describe("checkOrigin", () => {
    const post = (h: PostSyncHandler, origin?: string, url = `${BASE}/connect/meta`) =>
      call(h, "POST", url, { json: {}, headers: origin ? { origin } : {} });

    it("blocks writes from foreign browser origins", async () => {
      const blocked = await post(handler, "https://evil.example");
      expect(blocked.status).toBe(403);
      expect(await blocked.json()).toEqual({ error: "Cross-origin request blocked." });
      expect((await post(handler, "null")).status).toBe(403);
      expect((await call(handler, "DELETE", "/accounts/x", { headers: { origin: "https://evil.example" } })).status).toBe(403);
      expect((await call(handler, "POST", "/media", { body: pngForm(), headers: { origin: "https://evil.example" } })).status).toBe(403);
      expect(mediaFiles(sync)).toEqual([]);
    });

    it("allows same-origin, listed origins, requests without Origin, and reads", async () => {
      expect((await post(handler, ORIGIN)).status).toBe(200);
      expect((await post(handler)).status).toBe(200);
      // The request's own origin (e.g. a dev server reached by another host name than publicUrl).
      expect((await post(handler, "http://localhost:8080", "http://localhost:8080/social/connect/meta")).status).toBe(200);
      expect((await post(withOptions({ allowedRedirectOrigins: [ORIGIN, "https://partner.example.org"] }), "https://partner.example.org")).status).toBe(200);
      expect((await call(handler, "GET", "/accounts", { headers: { origin: "https://evil.example" } })).status).toBe(200);
    });

    it("can be turned off", async () => {
      expect((await post(withOptions({ checkOrigin: false }), "https://evil.example")).status).toBe(200);
    });

    it("doesn't affect paths outside the API", async () => {
      const res = await post(handler, "https://evil.example", `${ORIGIN}/elsewhere`);
      expect(res.status).toBe(404);
      expect(res.headers.get("x-post-sync-unmatched")).toBe("1");
    });
  });

  describe("JSON bodies", () => {
    it("rejects bodies over maxJsonBytes with 413", async () => {
      const small = withOptions({ maxJsonBytes: 64 });
      const res = await call(small, "POST", "/posts/validate", { json: { text: "x".repeat(200) } });
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: "Request body too large." });
      expect((await call(handler, "POST", "/posts", { json: { text: "x".repeat(1_100_000) } })).status).toBe(413);
    });

    it("needs a JSON content type and valid JSON", async () => {
      const plain = await call(handler, "POST", "/posts", { body: '{"text":"hi"}', headers: { "content-type": "text/plain" } });
      expect(plain.status).toBe(400);
      expect(((await plain.json()) as any).error).toMatch(/Content-Type: application\/json/);
      const form = await call(handler, "POST", "/posts", { body: new URLSearchParams({ text: "hi" }) });
      expect(form.status).toBe(400);
      const invalid = await call(handler, "POST", "/posts", { body: "{nope", headers: { "content-type": "application/json" } });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({ error: "Invalid JSON body." });
      const typed = await call(handler, "POST", "/posts/validate", { body: '{"text":5}', headers: { "content-type": "application/json; charset=utf-8" } });
      expect(((await typed.json()) as any).error).toBe("`text` must be a string.");
      // An empty body is an empty object.
      expect((await call(handler, "POST", "/connect/meta", { headers: { "content-type": "application/json" } })).status).toBe(200);
    });
  });

  describe("uploads", () => {
    it("rejects files over maxUploadMb and leaves nothing in mediaDir", async () => {
      const { type, body } = await slowMultipart(bigForm(3 * 1024 * 1024));
      const res = await call(handler, "POST", "/media", { body, headers: { "content-type": type } });
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error).toMatch(/larger than the 1 MB upload limit/);
      expect(mediaFiles(sync)).toEqual([]);

      // Same when everything arrives at once.
      expect((await call(handler, "POST", "/media", { body: bigForm(2 * 1024 * 1024) })).status).toBe(400);
      expect(mediaFiles(sync)).toEqual([]);
    });

    it("removes a partly written file when the form is cut off", async () => {
      const encoded = new Request("http://encode.local/", { method: "POST", body: bigForm(200_000) });
      const bytes = Buffer.from(await encoded.arrayBuffer());
      const res = await call(handler, "POST", "/media", {
        body: bytes.subarray(0, bytes.length - 1000),
        headers: { "content-type": encoded.headers.get("content-type")! },
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error).toMatch(/Upload failed/);
      expect(mediaFiles(sync)).toEqual([]);
    });

    it("accepts up to 20 files per request and rejects more", async () => {
      const many = await call(handler, "POST", "/media", { body: pngForm(21) });
      expect(many.status).toBe(400);
      expect(((await many.json()) as any).error).toBe("Too many files (max 20).");

      const twenty = await call(handler, "POST", "/media", { body: pngForm(20) });
      expect(twenty.status).toBe(201);
      const { media } = (await twenty.json()) as any;
      expect(media).toHaveLength(20);
      expect(media.map((m: any) => m.filename)).toEqual(Array.from({ length: 20 }, (_, i) => `dot${i}.png`));
    });

    it("rejects other upload mistakes with 400", async () => {
      expect((await call(handler, "POST", "/media", { json: { file: "x" } })).status).toBe(400);
      const fields = new FormData();
      fields.append("caption", "no file here");
      const empty = await call(handler, "POST", "/media", { body: fields });
      expect(empty.status).toBe(400);
      expect(((await empty.json()) as any).error).toMatch(/No files received/);
      const text = new FormData();
      text.append("file", new Blob(["hello"], { type: "text/plain" }), "notes.txt");
      const unsupported = await call(handler, "POST", "/media", { body: text });
      expect(unsupported.status).toBe(400);
      expect(((await unsupported.json()) as any).error).toMatch(/Unsupported file type/);
      const malformed = await call(handler, "POST", "/media", { body: "x", headers: { "content-type": "multipart/form-data" } });
      expect(malformed.status).toBe(400);
      expect(mediaFiles(sync)).toEqual([]);
    });
  });

  describe("media files", () => {
    let url: string;
    beforeEach(async () => {
      url = (await sync.media.fromBuffer("alice", BYTES, "pattern.png")).url;
    });

    const get = (target: string, headers: Record<string, string> = {}, method = "GET") => call(handler, method, target, { user: null, headers });

    it("serves the whole file publicly", async () => {
      const res = await get(url);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("content-length")).toBe("1000");
      expect(res.headers.get("accept-ranges")).toBe("bytes");
      expect(Buffer.from(await res.arrayBuffer()).equals(BYTES)).toBe(true);
    });

    it.each([
      ["bytes=0-99", 0, 99],
      ["bytes=900-", 900, 999],
      ["bytes=990-5000", 990, 999],
      ["bytes=-100", 900, 999],
      ["bytes=-5000", 0, 999],
    ])("answers Range %s with 206", async (range, start, end) => {
      const res = await get(url, { range });
      expect(res.status).toBe(206);
      expect(res.headers.get("content-range")).toBe(`bytes ${start}-${end}/1000`);
      expect(res.headers.get("content-length")).toBe(String(end - start + 1));
      expect(Buffer.from(await res.arrayBuffer()).equals(BYTES.subarray(start, end + 1))).toBe(true);
    });

    it("answers unsatisfiable ranges with 416 and ignores other units", async () => {
      for (const range of ["bytes=1000-", "bytes=5000-6000", "bytes=-0"]) {
        const res = await get(url, { range });
        expect(res.status).toBe(416);
        expect(res.headers.get("content-range")).toBe("bytes */1000");
      }
      expect((await get(url, { range: "items=0-1" })).status).toBe(200);
    });

    it("answers HEAD with headers only", async () => {
      const head = await get(url, {}, "HEAD");
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe("1000");
      expect((await head.arrayBuffer()).byteLength).toBe(0);
      const partial = await get(url, { range: "bytes=10-19" }, "HEAD");
      expect(partial.status).toBe(206);
      expect(partial.headers.get("content-length")).toBe("10");
      expect((await partial.arrayBuffer()).byteLength).toBe(0);
    });

    it("refuses tampered, foreign and traversal URLs with 404", async () => {
      const u = new URL(url);
      const [, , , sig, file] = u.pathname.split("/");
      const flipped = sig.slice(0, -1) + (sig.endsWith("a") ? "b" : "a");
      const other = new URL((await sync.media.fromBuffer("alice", PNG, "other.png")).url).pathname.split("/").pop();
      for (const path of [
        `/media/${flipped}/${file}`,
        `/media/${sig}/${other}`,
        `/media/${sig}/${file.replace(".png", ".jpg")}`,
        `/media/${sig}/..%2F..%2Fpost-sync.db`,
        `/media/${sig}/%2e%2e`,
      ]) {
        expect((await get(BASE + path)).status, path).toBe(404);
      }
    });

    it("stops serving a file once it is deleted", async () => {
      const media = await sync.media.fromBuffer("alice", PNG, "gone.png");
      expect((await get(media.url)).status).toBe(200);
      expect(await sync.media.remove("alice", media.id)).toBe("deleted");
      expect((await get(media.url)).status).toBe(404);
    });
  });

  describe("POST /media/from-url", () => {
    const cdnOnly = (u: URL) => u.hostname === "cdn.example.com";

    it("is refused unless allowRemoteMedia is set", async () => {
      const fetchMock = mockFetch([]);
      const res = await call(handler, "POST", "/media/from-url", { json: { url: "https://cdn.example.com/a.png" } });
      expect(res.status).toBe(403);
      expect(fetchMock.calls).toHaveLength(0);
    });

    it("downloads allowed URLs and checks every redirect against allowRemoteMedia", async () => {
      const fetchMock = mockFetch([
        { match: "https://cdn.example.com/moved.png", reply: () => ({ status: 302, headers: { location: "/real.png" } }) },
        { match: "https://cdn.example.com/real.png", reply: () => ({ text: "not really a png", headers: { "content-type": "image/png" } }) },
        { match: "https://cdn.example.com/escape.png", reply: () => ({ status: 302, headers: { location: "https://evil.example/x.png" } }) },
        { match: "https://evil.example/", reply: () => ({ text: "nope", headers: { "content-type": "image/png" } }) },
      ]);
      const h = withOptions({ allowRemoteMedia: cdnOnly });

      const ok = await call(h, "POST", "/media/from-url", { json: { url: "https://cdn.example.com/moved.png", filename: "mine.png" } });
      expect(ok.status).toBe(201);
      const { media } = (await ok.json()) as any;
      expect(media).toMatchObject({ ownerId: "alice", filename: "mine.png", kind: "image" });

      const escaped = await call(h, "POST", "/media/from-url", { json: { url: "https://cdn.example.com/escape.png" } });
      expect(escaped.status).toBe(403);
      expect(((await escaped.json()) as any).error).toMatch(/evil\.example/);
      expect(fetchMock.calls.some((c) => c.url.hostname === "evil.example")).toBe(false);

      expect((await call(h, "POST", "/media/from-url", { json: { url: "https://evil.example/x.png" } })).status).toBe(403);
      expect((await call(h, "POST", "/media/from-url", { json: { url: "not a url" } })).status).toBe(400);
      expect((await call(h, "POST", "/media/from-url", { json: {} })).status).toBe(400);
      expect(fetchMock.calls.map((c) => c.url.href)).toEqual([
        "https://cdn.example.com/moved.png",
        "https://cdn.example.com/real.png",
        "https://cdn.example.com/escape.png",
      ]);
      expect(mediaFiles(sync)).toHaveLength(1);
    });
  });

  describe("authenticate", () => {
    const withAuth = (authenticate: HandlerOptions["authenticate"]) => createHandler(sync, { authenticate });

    it("answers 401 when it returns no owner", async () => {
      for (const owner of [null, undefined, ""]) {
        const res = await call(withAuth(() => owner), "GET", "/accounts");
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: "Not logged in." });
      }
      expect((await call(createHandler(sync), "GET", "/accounts")).status).toBe(401);
    });

    it("passes 4xx errors through and hides others behind a 500", async () => {
      const bad = await call(withAuth(() => Promise.reject(Object.assign(new Error("Bad token"), { status: 400 }))), "GET", "/accounts");
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({ error: "Bad token" });
      const forbidden = await call(withAuth(() => { throw Object.assign(new Error("No access"), { statusCode: 403 }); }), "GET", "/accounts");
      expect(forbidden.status).toBe(403);

      const logged = vi.spyOn(sync.logger, "error");
      const crash = await call(withAuth(() => { throw new Error("database password is hunter2"); }), "GET", "/accounts");
      expect(crash.status).toBe(500);
      expect(await crash.json()).toEqual({ error: "Internal server error" });
      expect(logged).toHaveBeenCalledOnce();
      const unavailable = await call(withAuth(() => { throw Object.assign(new Error("down"), { status: 503 }); }), "GET", "/accounts");
      expect(unavailable.status).toBe(500);
    });

    it("isn't required for public routes", async () => {
      const h = withAuth(() => { throw new Error("nobody is logged in"); });
      const media = await sync.media.fromBuffer("alice", PNG, "dot.png");
      expect((await call(h, "GET", media.url)).status).toBe(200);
      // OAuth callbacks ask who is logged in, but a failing hook just means nobody.
      expect((await call(h, "GET", "/oauth/meta/callback?state=x")).status).toBe(302);
    });

    it("prefers the adapter's getOwnerId", async () => {
      const authenticate = vi.fn(() => "alice");
      const res = await createHandler(sync, { authenticate }).fetch(new Request(`${BASE}/accounts`), { getOwnerId: async () => null });
      expect(res.status).toBe(401);
      expect(authenticate).not.toHaveBeenCalled();
    });
  });

  describe("paths", () => {
    it("only matches requests under basePath", async () => {
      expect(handler.basePath).toBe("/social");
      expect((await call(handler, "GET", `${ORIGIN}/social/platforms`)).status).toBe(200);
      for (const path of ["/platforms", "/socialx/platforms", "/social", "/social/", "/social/nope", "/api/social/platforms"]) {
        const res = await call(handler, "GET", ORIGIN + path);
        expect(res.status, path).toBe(404);
        expect(res.headers.get("x-post-sync-unmatched"), path).toBe("1");
      }
      // Known path, unknown method.
      expect((await call(handler, "PUT", "/accounts")).headers.get("x-post-sync-unmatched")).toBe("1");
    });

    it("can be mounted elsewhere than publicUrl's path", async () => {
      const nested = withOptions({ basePath: "/api/v1/social/" });
      expect(nested.basePath).toBe("/api/v1/social");
      expect((await call(nested, "GET", "http://internal:3000/api/v1/social/platforms")).status).toBe(200);
      expect((await call(nested, "GET", `${BASE}/platforms`)).headers.get("x-post-sync-unmatched")).toBe("1");
      // Behind a proxy that strips the prefix.
      const root = withOptions({ basePath: "/" });
      expect(root.basePath).toBe("");
      expect((await call(root, "GET", "http://internal:3000/platforms")).status).toBe(200);
    });

    it("decodes percent-encoded segments", async () => {
      const slash = await call(handler, "GET", "/accounts/a%2Fb");
      expect(slash.status).toBe(404);
      expect(await slash.json()).toEqual({ error: "Account not found." });
      expect(slash.headers.get("x-post-sync-unmatched")).toBeNull();
      expect((await call(handler, "GET", "/posts/%20")).status).toBe(404);
      const broken = await call(handler, "GET", "/accounts/%E0%A4%A");
      expect(broken.status).toBe(400);
      expect(await broken.json()).toEqual({ error: "Bad path." });

      mockFetch(blueskyRoutes());
      const [account] = await sync.connect.withCredentials("alice", "bluesky", { identifier: "alice.bsky.social", appPassword: "p" });
      const encoded = await call(handler, "GET", `/accounts/${encodeURIComponent(account.id)}`);
      expect(((await encoded.json()) as any).account.id).toBe(account.id);
    });
  });
});

// ---- framework adapters --------------------------------------------------------------------------------

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

/** A request with full control over headers (fetch won't send a bad Host). */
function rawRequest(base: string, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("Express adapter", () => {
  let sync: PostSync;
  let server: http.Server | undefined;
  beforeEach(async () => {
    clearBlueskySessions();
    sync = await makeSync();
  });
  afterEach(async () => {
    if (server) await closeServer(server);
    server = undefined;
    await sync.close();
  });

  type Order = "json-first" | "json-last";
  async function start(order: Order): Promise<string> {
    const app = express();
    if (order === "json-first") app.use(express.json());
    app.use("/social", postSyncExpress(sync, { authenticate: (req) => req.headers["x-user"] ?? null }));
    if (order === "json-last") app.use(express.json());
    app.all("/social/custom", (req, res) => {
      res.json({ handledBy: "custom", method: req.method, body: req.body ?? null });
    });
    app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(err.status ?? 500).json({ handledBy: "express", message: err.message });
    });
    server = http.createServer(app);
    return listen(server);
  }

  const json = (body: unknown, user = "alice") => ({
    method: "POST",
    headers: { "content-type": "application/json", "x-user": user },
    body: JSON.stringify(body),
  });

  it.each<Order>(["json-first", "json-last"])("handles JSON requests (%s)", async (order) => {
    const base = await start(order);
    mockFetch(blueskyRoutes());
    const connected = await realFetch(`${base}/social/connect/bluesky/credentials`, json({ fields: { identifier: "alice.bsky.social", appPassword: "p" } }));
    expect(connected.status).toBe(201);
    const { accounts } = (await connected.json()) as any;
    expect(accounts[0]).toMatchObject({ ownerId: "alice", platform: "bluesky", username: "alice.bsky.social" });

    const created = await realFetch(`${base}/social/posts`, json({ text: "Hello from Express", targets: [{ accountId: accounts[0].id }] }));
    expect(created.status).toBe(201);
    expect(((await created.json()) as any).post.text).toBe("Hello from Express");

    const invalid = await realFetch(`${base}/social/posts/validate`, json({ text: 5 }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "`text` must be a string." });
    expect((await realFetch(`${base}/social/accounts`)).status).toBe(401);
  });

  it.each<Order>(["json-first", "json-last"])("streams multipart uploads and serves media (%s)", async (order) => {
    const base = await start(order);
    const up = await realFetch(`${base}/social/media`, { method: "POST", headers: { "x-user": "alice" }, body: pngForm(2) });
    expect(up.status).toBe(201);
    const { media } = (await up.json()) as any;
    expect(media.map((m: any) => m.filename)).toEqual(["dot0.png", "dot1.png"]);

    const filePath = new URL(media[0].url).pathname;
    const file = await realFetch(base + filePath);
    expect(file.status).toBe(200);
    expect(Buffer.from(await file.arrayBuffer()).equals(PNG)).toBe(true);
    const range = await realFetch(base + filePath, { headers: { range: "bytes=0-7" } });
    expect(range.status).toBe(206);
    expect(Buffer.from(await range.arrayBuffer()).equals(PNG.subarray(0, 8))).toBe(true);
    const head = await realFetch(base + filePath, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(PNG.length));
  });

  it.each<Order>(["json-first", "json-last"])("rejects bad bodies with an error response, not a dropped connection (%s)", async (order) => {
    const base = await start(order);
    const plain = await realFetch(`${base}/social/posts`, { method: "POST", headers: { "x-user": "alice", "content-type": "text/plain" }, body: "x".repeat(100_000) });
    expect(plain.status).toBe(400);
    expect(((await plain.json()) as any).error).toMatch(/Send JSON/);

    const big = await realFetch(`${base}/social/media`, { method: "POST", headers: { "x-user": "alice" }, body: bigForm(3 * 1024 * 1024) });
    expect(big.status).toBe(400);
    expect(((await big.json()) as any).error).toMatch(/upload limit/);
    expect(mediaFiles(sync)).toEqual([]);

    // The server is still fine.
    expect((await realFetch(`${base}/social/platforms`, { headers: { "x-user": "alice" } })).status).toBe(200);
  });

  it.each<Order>(["json-first", "json-last"])("falls through to later routes for paths it doesn't handle (%s)", async (order) => {
    const base = await start(order);
    const get = await realFetch(`${base}/social/custom`);
    expect(await get.json()).toEqual({ handledBy: "custom", method: "GET", body: null });
    // The body is still there for the later route's own parser.
    const posted = await realFetch(`${base}/social/custom`, json({ a: 1 }));
    expect(await posted.json()).toEqual({ handledBy: "custom", method: "POST", body: { a: 1 } });
    const put = await realFetch(`${base}/social/accounts`, { method: "PUT", headers: { "x-user": "alice" } });
    expect(put.status).toBe(404);
    expect(put.headers.get("x-post-sync-unmatched")).toBeNull();
  });

  it("sends errors to Express's error handler", async () => {
    const base = await start("json-first");
    // express.json() refuses invalid JSON before the handler sees it.
    const invalid = await realFetch(`${base}/social/posts`, { method: "POST", headers: { "x-user": "alice", "content-type": "application/json" }, body: "{nope" });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as any).handledBy).toBe("express");
    // A malformed Host header is no error: the request is served as if for localhost.
    const badHost = await rawRequest(base, "/social/platforms", { host: "[", "x-user": "alice" });
    expect(badHost.status).toBe(200);
  });

  it("answers CORS preflights", async () => {
    const app = express();
    app.use("/social", postSyncExpress(sync, { authenticate: () => "alice", cors: { origins: ["https://spa.example.org"] } }));
    server = http.createServer(app);
    const base = await listen(server);
    const res = await realFetch(`${base}/social/posts`, {
      method: "OPTIONS",
      headers: { origin: "https://spa.example.org", "access-control-request-method": "POST" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://spa.example.org");
  });
});

describe("node:http adapter", () => {
  let sync: PostSync;
  let server: http.Server;
  let base: string;
  beforeEach(async () => {
    sync = await makeSync();
    server = http.createServer(toNodeHandler(createHandler(sync), { authenticate: (req) => (req.headers["x-user"] as string | undefined) ?? null }));
    base = await listen(server);
  });
  afterEach(async () => {
    await closeServer(server);
    await sync.close();
  });

  it("serves the API and answers unknown paths with a plain 404", async () => {
    const platforms = await realFetch(`${base}/social/platforms`, { headers: { "x-user": "alice" } });
    expect(platforms.status).toBe(200);
    expect(((await platforms.json()) as any).connectors.find((c: any) => c.id === "meta").configured).toBe(true);

    const unknown = await realFetch(`${base}/elsewhere`);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "Not found" });
    expect(unknown.headers.get("x-post-sync-unmatched")).toBeNull();
  });

  it("reads JSON and multipart bodies from the stream", async () => {
    const started = await realFetch(`${base}/social/connect/meta`, {
      method: "POST",
      headers: { "x-user": "alice", "content-type": "application/json" },
      body: JSON.stringify({ returnTo: "/after" }),
    });
    expect(started.status).toBe(200);
    expect(((await started.json()) as any).url).toMatch(/^https:\/\/www\.facebook\.com\//);

    const up = await realFetch(`${base}/social/media`, { method: "POST", headers: { "x-user": "alice" }, body: pngForm() });
    expect(up.status).toBe(201);
    const big = await realFetch(`${base}/social/media`, { method: "POST", headers: { "x-user": "alice" }, body: bigForm(3 * 1024 * 1024) });
    expect(big.status).toBe(400);
    expect(mediaFiles(sync)).toHaveLength(1);

    const plain = await realFetch(`${base}/social/posts`, { method: "POST", headers: { "x-user": "alice", "content-type": "text/plain" }, body: "hi" });
    expect(plain.status).toBe(400);
    const tooBig = await realFetch(`${base}/social/posts`, {
      method: "POST",
      headers: { "x-user": "alice", "content-type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(1_100_000) }),
    });
    expect(tooBig.status).toBe(413);
  });

  it("answers 500 when there is no next() to hand an error to", async () => {
    const broken = http.createServer(toNodeHandler({ basePath: "", fetch: () => Promise.reject(new Error("boom")) }));
    try {
      const res = await rawRequest(await listen(broken), "/social/platforms", { "x-user": "alice" });
      expect(res.status).toBe(500);
      expect(res.body).toBe("Internal server error");
    } finally {
      await closeServer(broken);
    }
  });
});

describe("Fastify adapter", () => {
  let sync: PostSync;
  let app: FastifyInstance;
  beforeEach(async () => {
    sync = await makeSync();
    app = Fastify();
    app.post("/echo", async (request) => ({ body: request.body }));
    await app.register(postSyncFastify, {
      prefix: "/social",
      sync,
      authenticate: (request) => (request.headers["x-user"] as string | undefined) ?? null,
    });
    app.post("/after", async (request) => ({ body: request.body }));
    await app.register(async (child) => child.post("/inner", async (request) => ({ body: request.body })), { prefix: "/other" });
  });
  afterEach(async () => {
    await app.close();
    await sync.close();
  });

  it("serves the API under the prefix", async () => {
    const platforms = await app.inject({ method: "GET", url: "/social/platforms", headers: { "x-user": "alice" } });
    expect(platforms.statusCode).toBe(200);
    expect(platforms.json().connectors.length).toBeGreaterThan(0);
    expect((await app.inject({ method: "GET", url: "/social/platforms" })).statusCode).toBe(401);

    const invalid = await app.inject({ method: "POST", url: "/social/posts/validate", headers: { "x-user": "alice" }, payload: { text: 5 } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: "`text` must be a string." });

    const started = await app.inject({ method: "POST", url: "/social/connect/meta", headers: { "x-user": "alice" }, payload: { returnTo: "/after" } });
    expect(started.statusCode).toBe(200);
    expect(started.json().url).toMatch(/^https:\/\/www\.facebook\.com\//);

    const callback = await app.inject({ method: "GET", url: "/social/oauth/meta/callback?state=unknown" });
    expect(callback.statusCode).toBe(302);
    expect(new URL(callback.headers.location as string).searchParams.get("postsync")).toBe("error");

    const unknown = await app.inject({ method: "GET", url: "/social/nope", headers: { "x-user": "alice" } });
    // Paths the API doesn't know go to Fastify's (or the host's) not-found handler.
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ statusCode: 404, message: "Route GET:/social/nope not found" });
    expect(unknown.headers["x-post-sync-unmatched"]).toBeUndefined();
  });

  it("keeps the host's JSON parsing outside the plugin", async () => {
    for (const url of ["/echo", "/after", "/other/inner"]) {
      const res = await app.inject({ method: "POST", url, payload: { hello: "world" } });
      expect(res.statusCode, url).toBe(200);
      expect(res.json(), url).toEqual({ body: { hello: "world" } });
      const invalid = await app.inject({ method: "POST", url, headers: { "content-type": "application/json" }, payload: "{nope" });
      expect(invalid.statusCode, url).toBe(400);
    }
  });

  it("takes multipart uploads through inject and serves media", async () => {
    const encoded = new Request("http://encode.local/", { method: "POST", body: pngForm() });
    const up = await app.inject({
      method: "POST",
      url: "/social/media",
      headers: { "x-user": "alice", "content-type": encoded.headers.get("content-type")! },
      payload: Buffer.from(await encoded.arrayBuffer()),
    });
    expect(up.statusCode).toBe(201);
    const filePath = new URL(up.json().media[0].url).pathname;
    const file = await app.inject({ method: "GET", url: filePath });
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(PNG)).toBe(true);
    const head = await app.inject({ method: "HEAD", url: filePath });
    expect(head.statusCode).toBe(200);
    expect(head.headers["content-length"]).toBe(String(PNG.length));
  });

  it("streams uploads over a real connection", async () => {
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const up = await realFetch(`${address}/social/media`, { method: "POST", headers: { "x-user": "alice" }, body: pngForm(3) });
    expect(up.status).toBe(201);
    expect(((await up.json()) as any).media).toHaveLength(3);

    const big = await realFetch(`${address}/social/media`, { method: "POST", headers: { "x-user": "alice" }, body: bigForm(3 * 1024 * 1024) });
    expect(big.status).toBe(400);
    expect(((await big.json()) as any).error).toMatch(/upload limit/);
    expect(mediaFiles(sync)).toHaveLength(3);

    const plain = await realFetch(`${address}/social/posts`, { method: "POST", headers: { "x-user": "alice", "content-type": "text/plain" }, body: "hi" });
    expect(plain.status).toBe(400);
    const echo = await realFetch(`${address}/echo`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"still":"works"}' });
    expect(await echo.json()).toEqual({ body: { still: "works" } });
  });
});
