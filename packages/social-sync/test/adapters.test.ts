import fs from "node:fs";
import http from "node:http";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import express from "express";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { postSyncExpress } from "../src/adapters/express.js";
import { postSyncFastify } from "../src/adapters/fastify.js";
import { formFilename } from "../src/handler/multipart.js";
import { createHandler, createPostSync, toNodeHandler, toWebRequest, type Logger, type PostSync, type PostSyncOptions } from "../src/index.js";
import { sqliteStorage } from "../src/storage/sqlite.js";
import { mockFetch, tempDir, TEST_SECRET } from "./helpers.js";

// Requests to local test servers always use the real fetch, even while a test mocks the platform APIs.
const realFetch = globalThis.fetch;

const ORIGIN = "https://app.example.com";
const BASE = `${ORIGIN}/social`;
const SPA = "https://spa.example.org";
// 1x1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

/** A logger whose calls tests can inspect (`sync.logger.warn` is a vi.fn()). */
function quietLogger(): Logger {
  return { info: vi.fn<Logger["info"]>(), warn: vi.fn<Logger["warn"]>(), error: vi.fn<Logger["error"]>() };
}

async function makeSync(options: Partial<PostSyncOptions> = {}): Promise<PostSync> {
  return createPostSync({
    secret: TEST_SECRET,
    publicUrl: BASE,
    storage: sqliteStorage(":memory:"),
    mediaDir: tempDir(),
    maxUploadMb: 1,
    logger: quietLogger(),
    worker: { autoStart: false },
    sleep: async () => {},
    platforms: { meta: { appId: "meta-app", appSecret: "meta-secret" } },
    ...options,
  });
}

const mediaFiles = (sync: PostSync) => fs.readdirSync(sync.config.mediaDir);

function pngForm(filename = "dot.png"): FormData {
  const form = new FormData();
  form.append("file", new Blob([PNG], { type: "image/png" }), filename);
  return form;
}

/** A form's multipart encoding, as fetch would send it. */
async function encodeForm(form: FormData): Promise<{ type: string; bytes: Buffer }> {
  const encoded = new Request("http://encode.local/", { method: "POST", body: form });
  return { type: encoded.headers.get("content-type")!, bytes: Buffer.from(await encoded.arrayBuffer()) };
}

async function listen(server: http.Server | http2.Http2Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** An HTTP/1.1 request with full control over the target, method and headers; fails instead of hanging. */
function rawRequest(base: string, opts: { method?: string; path: string; headers?: Record<string, string>; body?: Buffer | string }): Promise<RawResponse> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, method: opts.method ?? "GET", path: opts.path, headers: opts.headers, timeout: 3000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("timeout", () => req.destroy(new Error(`no response to ${opts.method ?? "GET"} ${opts.path}`)));
    req.on("error", reject);
    req.end(opts.body);
  });
}

interface H2Response {
  status: number;
  headers: http2.IncomingHttpHeaders;
  body: string;
}

/** One request on an HTTP/2 session; fails instead of hanging. */
function h2Request(client: http2.ClientHttp2Session, headers: http2.OutgoingHttpHeaders, body?: Buffer | string): Promise<H2Response> {
  return new Promise((resolve, reject) => {
    const req = client.request(headers);
    req.setTimeout(3000, () => req.close(http2.constants.NGHTTP2_CANCEL));
    let status = 0;
    let resHeaders: http2.IncomingHttpHeaders = {};
    const chunks: Buffer[] = [];
    req.on("response", (h) => {
      status = Number(h[":status"]);
      resHeaders = h;
    });
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve({ status, headers: resHeaders, body: Buffer.concat(chunks).toString("utf8") }));
    req.on("close", () => {
      if (!status) reject(new Error(`no response to ${String(headers[":method"] ?? "GET")} ${String(headers[":path"])}`));
    });
    req.on("error", reject);
    req.end(body);
  });
}

const fakeReq = (props: { url: string; headers?: Record<string, string>; method?: string; encrypted?: boolean }) =>
  ({ method: props.method ?? "GET", url: props.url, headers: props.headers ?? {}, socket: { encrypted: props.encrypted } }) as any;

describe("toWebRequest", () => {
  it("keeps a target that starts with // on the request's own origin", () => {
    const req = toWebRequest(fakeReq({ url: "//evil.example.com/social/posts", headers: { host: "app.example.com" } }));
    const url = new URL(req.url);
    expect(url.origin).toBe("http://app.example.com");
    expect(url.pathname).toBe("//evil.example.com/social/posts");
    expect(new URL(toWebRequest(fakeReq({ url: "/\\evil.example.com/x", headers: { host: "app.example.com" } })).url).host).toBe("app.example.com");
    // Absolute-form targets (meant for proxies) don't pick the origin either.
    const absolute = toWebRequest(fakeReq({ url: "http://evil.example.com/social/posts", headers: { host: "app.example.com" } }));
    expect(absolute.url).toBe("http://app.example.com/");
  });

  it("takes the scheme from X-Forwarded-Proto only when it is http or https", () => {
    const scheme = (headers: Record<string, string>, encrypted?: boolean) =>
      new URL(toWebRequest(fakeReq({ url: "/x", headers: { host: "app.example.com", ...headers }, encrypted })).url).protocol;
    expect(scheme({ "x-forwarded-proto": "https" })).toBe("https:");
    expect(scheme({ "x-forwarded-proto": "HTTPS, http" })).toBe("https:");
    expect(scheme({ "x-forwarded-proto": "javascript" })).toBe("http:");
    expect(scheme({ "x-forwarded-proto": "a b" }, true)).toBe("https:");
    expect(scheme({ ":scheme": "https" })).toBe("https:");
    expect(scheme({}, true)).toBe("https:");
  });

  it("falls back to localhost for a missing or malformed Host", () => {
    const host = (value?: string) => new URL(toWebRequest(fakeReq({ url: "/x", headers: value === undefined ? {} : { host: value } })).url).host;
    expect(host("app.example.com:8443")).toBe("app.example.com:8443");
    expect(host("[::1]:3000")).toBe("[::1]:3000");
    for (const bad of [undefined, "", "[", "a b", "evil.example.com@app.example.com", "app.example.com/x", "app.example.com?x", "app.example.com#x"]) {
      expect(host(bad), String(bad)).toBe("localhost");
    }
  });

  it("drops HTTP/2 pseudo-headers and uses :authority as the host", () => {
    const req = toWebRequest(
      fakeReq({ url: "/social/platforms", headers: { ":method": "GET", ":path": "/social/platforms", ":scheme": "https", ":authority": "app.example.com", "x-user": "alice" } }),
    );
    expect(req.url).toBe("https://app.example.com/social/platforms");
    expect([...req.headers.keys()]).toEqual(["x-user"]);
  });
});

describe("request targets starting with //", () => {
  let sync: PostSync;
  let server: http.Server | undefined;
  beforeEach(async () => {
    sync = await makeSync();
  });
  afterEach(async () => {
    if (server) await closeServer(server);
    server = undefined;
    await sync.close();
  });

  async function crossSiteUpload(base: string, path: string): Promise<RawResponse> {
    const { type, bytes } = await encodeForm(pngForm());
    // What a page on evil.example.com can make a browser send: its own Origin, any path on the victim's host.
    return rawRequest(base, { method: "POST", path, headers: { origin: "http://evil.example.com", "content-type": type }, body: bytes });
  }

  it("never act through the node:http adapter", async () => {
    server = http.createServer(toNodeHandler(createHandler(sync), { authenticate: () => "alice" }));
    const base = await listen(server);
    for (const path of ["//evil.example.com/social/media", "/\\evil.example.com/social/media", "//evil.example.com/../social/media"]) {
      const res = await crossSiteUpload(base, path);
      expect([403, 404], path).toContain(res.status);
    }
    expect(mediaFiles(sync)).toEqual([]);
    // The same request from the page's own origin still works.
    const { type, bytes } = await encodeForm(pngForm());
    const own = await rawRequest(base, { method: "POST", path: "/social/media", headers: { origin: base, "content-type": type }, body: bytes });
    expect(own.status).toBe(201);
  });

  it("never act through Express mounted at the root", async () => {
    const app = express();
    app.use(postSyncExpress(sync, { authenticate: () => "alice" }));
    server = http.createServer(app);
    const base = await listen(server);
    for (const path of ["//evil.example.com/social/media", "/\\evil.example.com/social/media"]) {
      const res = await crossSiteUpload(base, path);
      expect([403, 404], path).toContain(res.status);
    }
    expect(mediaFiles(sync)).toEqual([]);
  });

  it("never act on a handler mounted at the root", async () => {
    server = http.createServer(toNodeHandler(createHandler(sync, { basePath: "/" }), { authenticate: () => "alice" }));
    const base = await listen(server);
    for (const path of ["//evil.example.com/media", "//media", "//evil.example.com/social/media"]) {
      const res = await crossSiteUpload(base, path);
      expect([403, 404], path).toContain(res.status);
    }
    expect(mediaFiles(sync)).toEqual([]);
  });
});

describe("JSON bodies", () => {
  let sync: PostSync;
  beforeEach(async () => {
    sync = await makeSync();
  });
  afterEach(async () => sync.close());

  const post = (type: string, body = '{"text":5}') =>
    createHandler(sync, { authenticate: () => "alice" }).fetch(
      new Request(`${BASE}/posts/validate`, { method: "POST", headers: { "content-type": type }, body }),
    );

  it("needs the media type to be JSON, not just mention it", async () => {
    // CORS-safelisted types (no preflight) that only contain "application/json" somewhere.
    for (const type of ["text/plain;x=application/json", "text/plain; charset=application/json", "application/x-www-form-urlencoded;application/json"]) {
      const res = await post(type);
      expect(res.status, type).toBe(400);
      expect(((await res.json()) as any).error, type).toMatch(/Send JSON/);
    }
    for (const type of ["application/json", "Application/JSON; charset=utf-8", " application/json ;charset=utf-8", "application/vnd.api+json"]) {
      const res = await post(type);
      expect(res.status, type).toBe(400);
      expect(await res.json(), type).toEqual({ error: "`text` must be a string." });
    }
  });
});

describe("HTTP/2", () => {
  let sync: PostSync;
  let client: http2.ClientHttp2Session | undefined;
  beforeEach(async () => {
    sync = await makeSync();
  });
  afterEach(async () => {
    client?.destroy();
    client = undefined;
    await sync.close();
  });

  async function exercise(base: string) {
    client = http2.connect(base);
    const platforms = await h2Request(client, { ":method": "GET", ":path": "/social/platforms", "x-user": "alice" });
    expect(platforms.status).toBe(200);
    expect(JSON.parse(platforms.body).connectors.length).toBeGreaterThan(0);
    expect((await h2Request(client, { ":method": "GET", ":path": "/social/platforms" })).status).toBe(401);

    // JSON bodies and cookies; the origin check compares against :scheme://:authority.
    const started = await h2Request(
      client,
      { ":method": "POST", ":path": "/social/connect/meta", "x-user": "alice", "content-type": "application/json", origin: base },
      JSON.stringify({ returnTo: "/after" }),
    );
    expect(started.status).toBe(200);
    expect(JSON.parse(started.body).url).toMatch(/^https:\/\/www\.facebook\.com\//);
    expect(String(started.headers["set-cookie"])).toMatch(/^postsync_oauth=/);
    const foreign = await h2Request(
      client,
      { ":method": "POST", ":path": "/social/connect/meta", "x-user": "alice", "content-type": "application/json", origin: "https://evil.example.com" },
      "{}",
    );
    expect(foreign.status).toBe(403);

    // Streaming uploads.
    const { type, bytes } = await encodeForm(pngForm());
    const up = await h2Request(client, { ":method": "POST", ":path": "/social/media", "x-user": "alice", "content-type": type }, bytes);
    expect(up.status).toBe(201);
    expect(mediaFiles(sync)).toHaveLength(1);

    const filePath = new URL(JSON.parse(up.body).media[0].url).pathname;
    const file = await h2Request(client, { ":method": "GET", ":path": filePath });
    expect(file.status).toBe(200);
    expect(file.body.length).toBeGreaterThan(0);
    const head = await h2Request(client, { ":method": "HEAD", ":path": filePath });
    expect(head.status).toBe(200);
    expect(head.headers["content-length"]).toBe(String(PNG.length));
    expect(head.body).toBe("");
    expect((await h2Request(client, { ":method": "HEAD", ":path": "/social/platforms", "x-user": "alice" })).status).toBe(200);
  }

  it("works with node:http2 and toNodeHandler", async () => {
    const server = http2.createServer(toNodeHandler(createHandler(sync), { authenticate: (req) => (req.headers["x-user"] as string | undefined) ?? null }));
    const base = await listen(server);
    try {
      await exercise(base);
      expect((await h2Request(client!, { ":method": "GET", ":path": "/elsewhere" })).status).toBe(404);
    } finally {
      client?.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("works with Fastify({ http2: true })", async () => {
    const app = Fastify({ http2: true });
    await app.register(postSyncFastify, { prefix: "/social", sync, authenticate: (req) => (req.headers["x-user"] as string | undefined) ?? null });
    const base = await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      await exercise(base);
      expect((await h2Request(client!, { ":method": "GET", ":path": "/social/nope" })).status).toBe(404);
    } finally {
      client?.destroy();
      await app.close();
    }
  });
});

describe("Fastify adapter", () => {
  let sync: PostSync;
  let app: FastifyInstance;
  beforeEach(async () => {
    sync = await makeSync();
    app = Fastify();
    // What @fastify/cors and @fastify/cookie do in the host's scope: headers set before the route, and in onSend.
    app.addHook("onRequest", async (_request, reply) => {
      reply.header("access-control-allow-origin", SPA);
      reply.header("access-control-allow-credentials", "true");
      reply.header("set-cookie", "host_cookie=1; Path=/");
    });
    app.addHook("onSend", async (_request, reply, payload) => {
      reply.header("x-on-send", "1");
      return payload;
    });
    app.setNotFoundHandler((request, reply) => reply.code(404).send({ hostNotFound: request.url }));
    await app.register(postSyncFastify, {
      prefix: "/social",
      sync,
      authenticate: (request) => (request.headers["x-user"] as string | undefined) ?? null,
    });
  });
  afterEach(async () => {
    await app.close();
    await sync.close();
  });

  it("keeps the host's headers and hooks on every response", async () => {
    const check = (res: { headers: Record<string, unknown> }, label: string) => {
      expect(res.headers["access-control-allow-origin"], label).toBe(SPA);
      expect(res.headers["access-control-allow-credentials"], label).toBe("true");
      expect(res.headers["x-on-send"], label).toBe("1");
    };
    const platforms = await app.inject({ method: "GET", url: "/social/platforms", headers: { "x-user": "alice" } });
    expect(platforms.statusCode).toBe(200);
    check(platforms, "200");
    const denied = await app.inject({ method: "GET", url: "/social/platforms" });
    expect(denied.statusCode).toBe(401);
    expect(denied.json()).toEqual({ error: "Not logged in." });
    check(denied, "401");

    // Both the host's cookie and the handler's.
    const started = await app.inject({ method: "POST", url: "/social/connect/meta", headers: { "x-user": "alice" }, payload: {} });
    expect(started.statusCode).toBe(200);
    check(started, "POST");
    const cookies = ([] as string[]).concat(started.headers["set-cookie"] as string | string[]);
    expect(cookies.map((c) => c.split("=")[0])).toEqual(["host_cookie", "postsync_oauth"]);

    const callback = await app.inject({ method: "GET", url: "/social/oauth/meta/callback?state=unknown" });
    expect(callback.statusCode).toBe(302);
    expect(callback.body).toBe("");
    check(callback, "302");
  });

  it("sends paths the API doesn't know to the host's not-found handler", async () => {
    const unknown = await app.inject({ method: "GET", url: "/social/nope", headers: { "x-user": "alice" } });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ hostNotFound: "/social/nope" });
    expect(unknown.headers["x-post-sync-unmatched"]).toBeUndefined();
    const put = await app.inject({ method: "PUT", url: "/social/accounts", headers: { "x-user": "alice" } });
    expect(put.json()).toEqual({ hostNotFound: "/social/accounts" });
  });

  it("answers HEAD with headers only and serves media", async () => {
    const media = await sync.media.fromBuffer("alice", PNG, "dot.png");
    const path = new URL(media.url).pathname;
    const head = await app.inject({ method: "HEAD", url: path });
    expect(head.statusCode).toBe(200);
    expect(head.headers["content-length"]).toBe(String(PNG.length));
    expect(head.headers["content-type"]).toBe("image/png");
    expect(head.rawPayload.length).toBe(0);
    const get = await app.inject({ method: "GET", url: path, headers: { range: "bytes=0-7" } });
    expect(get.statusCode).toBe(206);
    expect(get.rawPayload.equals(PNG.subarray(0, 8))).toBe(true);
    expect((await app.inject({ method: "HEAD", url: "/social/accounts", headers: { "x-user": "alice" } })).statusCode).toBe(200);
  });

  it("answers preflights with the plugin's own cors option", async () => {
    const own = Fastify();
    await own.register(postSyncFastify, { prefix: "/social", sync, authenticate: () => "alice", cors: { origins: [SPA], credentials: true } });
    try {
      const preflight = await own.inject({ method: "OPTIONS", url: "/social/posts", headers: { origin: SPA, "access-control-request-method": "POST" } });
      expect(preflight.statusCode).toBe(204);
      expect(preflight.body).toBe("");
      expect(preflight.headers["access-control-allow-origin"]).toBe(SPA);
      expect(preflight.headers["access-control-allow-credentials"]).toBe("true");
      const res = await own.inject({ method: "GET", url: "/social/platforms", headers: { origin: SPA } });
      expect(res.statusCode).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBe(SPA);
    } finally {
      await own.close();
    }
  });

  it("answers requests it can't turn into a web Request with 400", async () => {
    // Characters above U+00FF can't be in a header; only an in-process request can carry them.
    const res = await app.inject({ method: "GET", url: "/social/platforms", headers: { "x-user": "alice", "x-bad": "Ā" } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Bad request." });
  });

  it("answers unusual requests over a real connection instead of hanging", async () => {
    const base = await app.listen({ port: 0, host: "127.0.0.1" });
    const trace = await rawRequest(base, { method: "TRACE", path: "/social/platforms", headers: { "x-user": "alice" } });
    expect(trace.status).toBe(404);
    const badHost = await rawRequest(base, { path: "/social/platforms", headers: { host: "[", "x-user": "alice" } });
    expect(badHost.status).toBe(200);
    const badProto = await rawRequest(base, { path: "/social/platforms", headers: { "x-forwarded-proto": "a b", "x-user": "alice" } });
    expect(badProto.status).toBe(200);
    expect(badProto.headers["access-control-allow-origin"]).toBe(SPA);

    // Streaming uploads still work, and the API's error responses keep the host's headers too.
    const up = await realFetch(`${base}/social/media`, { method: "POST", headers: { "x-user": "alice" }, body: pngForm() });
    expect(up.status).toBe(201);
    const big = new FormData();
    big.append("file", new Blob([Buffer.alloc(3 * 1024 * 1024, 1)], { type: "image/png" }), "big.png");
    const tooBig = await realFetch(`${base}/social/media`, { method: "POST", headers: { "x-user": "alice" }, body: big });
    expect(tooBig.status).toBe(400);
    expect(tooBig.headers.get("access-control-allow-origin")).toBe(SPA);
    expect(mediaFiles(sync)).toHaveLength(1);
  });
});

describe("node:http adapter", () => {
  let sync: PostSync;
  let server: http.Server | undefined;
  beforeEach(async () => {
    sync = await makeSync();
  });
  afterEach(async () => {
    if (server) await closeServer(server);
    server = undefined;
    await sync.close();
  });

  it("answers requests it can't turn into a web Request with 400, or leaves them to next()", async () => {
    server = http.createServer(toNodeHandler(createHandler(sync), { authenticate: () => "alice" }));
    const base = await listen(server);
    const trace = await rawRequest(base, { method: "TRACE", path: "/social/platforms" });
    expect(trace.status).toBe(400);
    expect(JSON.parse(trace.body)).toEqual({ error: "Bad request." });
    expect((await rawRequest(base, { path: "/social/platforms", headers: { host: "[" } })).status).toBe(200);
    await closeServer(server);

    // In Express, a TRACE request goes on to the host's own routes.
    const app = express();
    app.use(postSyncExpress(sync, { authenticate: () => "alice" }));
    app.trace("/social/platforms", (_req, res) => {
      res.json({ handledBy: "host" });
    });
    server = http.createServer(app);
    const expressBase = await listen(server);
    const traced = await rawRequest(expressBase, { method: "TRACE", path: "/social/platforms" });
    expect(traced.status).toBe(200);
    expect(JSON.parse(traced.body)).toEqual({ handledBy: "host" });
  });
});

describe("authenticate results", () => {
  let sync: PostSync;
  beforeEach(async () => {
    sync = await makeSync();
  });
  afterEach(async () => sync.close());

  const accounts = (owner: unknown) => createHandler(sync, { authenticate: () => owner as any }).fetch(new Request(`${BASE}/accounts`));

  it("accepts non-blank strings and finite numbers", async () => {
    const media = await sync.media.fromBuffer("42", PNG, "dot.png");
    for (const owner of ["42", 42, 42n]) {
      const res = await createHandler(sync, { authenticate: () => owner as any }).fetch(new Request(`${BASE}/media/${media.id}`));
      expect(res.status, String(owner)).toBe(200);
    }
    expect((await accounts(" alice ")).status).toBe(200);
    expect((await accounts(0)).status).toBe(200);
    expect(sync.logger.warn).not.toHaveBeenCalled();
  });

  it("answers 401 for anything else and warns once per kind of value", async () => {
    let owner: unknown;
    const handler = createHandler(sync, { authenticate: () => owner as any });
    const values = [false, true, { id: "alice" }, { id: "bob" }, ["alice"], NaN, Infinity, () => "alice", Symbol("alice"), "   "];
    for (const value of values) {
      owner = value;
      const res = await handler.fetch(new Request(`${BASE}/accounts`));
      expect(res.status, String(typeof value)).toBe(401);
      expect(await res.json()).toEqual({ error: "Not logged in." });
    }
    // The same through an adapter's getOwnerId (another handler warns again).
    const adapter = createHandler(sync);
    expect((await adapter.fetch(new Request(`${BASE}/accounts`), { getOwnerId: () => ({ id: "alice" }) as any })).status).toBe(401);

    const warnings = vi.mocked(sync.logger.warn).mock.calls.map((c) => c[0] as string);
    expect(warnings.map((w) => w.match(/of type (.+?), not an id/)?.[1])).toEqual([
      "boolean",
      "object",
      "array",
      "number (NaN)",
      "number (Infinity)",
      "function",
      "symbol",
      "object",
    ]);
  });
});

describe("defaultReturnTo", () => {
  let sync: PostSync;
  beforeEach(async () => {
    sync = await makeSync();
  });
  afterEach(async () => sync.close());

  const graph = "https://graph.facebook.com/v26.0";

  it("may be a path on publicUrl's origin, used after a completed login", async () => {
    const handler = createHandler(sync, { authenticate: () => "alice", defaultReturnTo: "/settings/social" });
    mockFetch([
      { method: "GET", match: `${graph}/oauth/access_token`, reply: () => ({ json: { access_token: "user-token" } }) },
      {
        method: "GET",
        match: `${graph}/me/permissions`,
        reply: () => ({
          json: { data: ["pages_show_list", "pages_manage_posts", "instagram_basic", "instagram_content_publish"].map((permission) => ({ permission, status: "granted" })) },
        }),
      },
      {
        method: "GET",
        match: `${graph}/me/accounts`,
        reply: () => ({ json: { data: [{ id: "page-1", name: "My Page", access_token: "page-token", tasks: ["CREATE_CONTENT"] }] } }),
      },
    ]);
    const started = await handler.fetch(new Request(`${BASE}/connect/meta`, { method: "POST" }));
    expect(started.status).toBe(200);
    const state = new URL(((await started.json()) as any).url).searchParams.get("state")!;
    const cookie = started.headers.get("set-cookie")!.split(";")[0];
    const done = await handler.fetch(new Request(`${BASE}/oauth/meta/callback?code=c&state=${encodeURIComponent(state)}`, { headers: { cookie } }));
    expect(done.status).toBe(302);
    const back = new URL(done.headers.get("location")!);
    expect(back.origin + back.pathname).toBe(`${ORIGIN}/settings/social`);
    expect(back.searchParams.get("postsync")).toBe("connected");
    expect(await sync.accounts.list("alice")).toHaveLength(1);

    const failed = await handler.fetch(new Request(`${BASE}/oauth/meta/callback?state=unknown`));
    expect(failed.status).toBe(302);
    expect(new URL(failed.headers.get("location")!).pathname).toBe("/settings/social");
  });

  it("must be on an allowed origin, checked when the handler is created", async () => {
    for (const bad of ["https://evil.example.com/", "//evil.example.com/x", "javascript:alert(1)", "http://[/"]) {
      expect(() => createHandler(sync, { defaultReturnTo: bad }), bad).toThrow(/defaultReturnTo/);
    }
    expect(() => createHandler(sync, { defaultReturnTo: `${SPA}/done`, allowedRedirectOrigins: [SPA] })).not.toThrow();
    // A path is fine even when publicUrl's origin isn't listed (paths are always allowed as returnTo too).
    expect(() => createHandler(sync, { defaultReturnTo: "/done", allowedRedirectOrigins: [SPA] })).not.toThrow();

    const app = Fastify();
    await expect(app.register(postSyncFastify, { prefix: "/social", sync, authenticate: () => "alice", defaultReturnTo: "https://evil.example.com/" })).rejects.toThrow(
      /defaultReturnTo/,
    );
    await app.close().catch(() => {});
  });
});

describe("upload filenames", () => {
  let sync: PostSync;
  beforeEach(async () => {
    sync = await makeSync();
  });
  afterEach(async () => sync.close());

  it("keeps UTF-8 names and the characters browsers escape", async () => {
    const handler = createHandler(sync, { authenticate: () => "alice" });
    for (const name of ["café 写真.png", 'say "hi".png', "100%25 done.png"]) {
      const res = await handler.fetch(new Request(`${BASE}/media`, { method: "POST", body: pngForm(name) }));
      expect(res.status, name).toBe(201);
      expect(((await res.json()) as any).media[0].filename).toBe(name);
    }
  });

  it("arrive intact over a real connection", async () => {
    const server = http.createServer(toNodeHandler(createHandler(sync), { authenticate: () => "alice" }));
    const base = await listen(server);
    try {
      const res = await realFetch(`${base}/social/media`, { method: "POST", body: pngForm("Ünïcödé 📷.png") });
      expect(res.status).toBe(201);
      expect(((await res.json()) as any).media[0].filename).toBe("Ünïcödé 📷.png");
    } finally {
      await closeServer(server);
    }
  });

  it("undoes only the escapes browsers apply", () => {
    expect(formFilename("a%22b%0D%0a.png")).toBe('a"b\r\n.png');
    expect(formFilename("100%25 %41.png")).toBe("100%25 %41.png");
    expect(formFilename(undefined)).toBe("");
  });
});

describe("500 log line", () => {
  it("puts the error text in the message", async () => {
    const sync = await makeSync();
    try {
      const handler = createHandler(sync, {
        authenticate: () => {
          throw new Error("database is down");
        },
      });
      expect((await handler.fetch(new Request(`${BASE}/accounts`))).status).toBe(500);
      const [message, err] = vi.mocked(sync.logger.error).mock.calls[0];
      expect(message).toBe("GET /social/accounts failed: database is down");
      expect(err).toBeInstanceOf(Error);
    } finally {
      await sync.close();
    }
  });
});
