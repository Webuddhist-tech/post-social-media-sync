import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Description, PostPage, PublicAccount, PublicMedia, PublicPost } from "post-social-media-sync";
import { sqliteStorage } from "post-social-media-sync/sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp, type HostApp } from "../src/app.js";

const SECRET = "example-host-secret-example-host-secret";
const PDS = "https://morel.us-east.host.bsky.network";
// 1x1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

// Requests from this test go to the real server; requests the engine makes to Bluesky are answered by a stub.
const realFetch = globalThis.fetch;
const handle = `host${Date.now()}.bsky.social`;

function stubBluesky(): string[] {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const reply = (data: unknown) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
    if (url.startsWith("https://bsky.social/xrpc/com.atproto.server.createSession")) {
      return reply({
        did: "did:plc:host",
        handle,
        accessJwt: "JWT",
        didDoc: { service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: PDS }] },
      });
    }
    if (url.startsWith(`${PDS}/xrpc/app.bsky.actor.getProfile`)) return reply({ displayName: "Host Blog" });
    if (url.startsWith(`${PDS}/xrpc/com.atproto.repo.createRecord`)) return reply({ uri: "at://did:plc:host/app.bsky.feed.post/3kq", cid: "c" });
    throw new TypeError(`fetch failed (unmocked ${url})`);
  });
  return calls;
}

describe("example express host", () => {
  let server: http.Server;
  let host: HostApp;
  let base: string;
  let dataDir: string;
  const logLines: string[] = [];

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pss-example-"));
    // Listen first so the app knows its real public URL (OAuth redirect URIs and media URLs are built from it).
    server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    host = await createApp({
      baseUrl: base,
      secret: SECRET,
      dataDir,
      storage: sqliteStorage(":memory:"),
      startWorker: false,
      logger: { info: (m) => logLines.push(m), warn: (m) => logLines.push(m), error: (m) => logLines.push(m) },
    });
    server.on("request", host.app);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await host.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const request = (method: string, url: string, opts: { cookie?: string; json?: unknown; headers?: Record<string, string>; body?: RequestInit["body"] } = {}) =>
    realFetch(base + url, {
      method,
      redirect: "manual",
      headers: {
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
        ...(opts.json !== undefined ? { "content-type": "application/json" } : {}),
        ...opts.headers,
      },
      body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body,
    });

  const json = async <T>(res: Response | Promise<Response>): Promise<T> => (await (await res).json()) as T;

  async function login(name: string): Promise<string> {
    const res = await request("POST", "/login", { json: { name } });
    expect(res.status).toBe(200);
    return res.headers.getSetCookie()[0].split(";")[0];
  }

  it("serves its own frontend and keeps the API behind its own login", async () => {
    const page = await request("GET", "/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("/social");

    const anonymous = await request("GET", "/social/accounts");
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ error: "Not logged in." });

    expect((await request("POST", "/login", { json: { name: "Not Valid!" } })).status).toBe(400);
    const forged = await request("GET", "/social/accounts", { cookie: "demo_user=alice.forged" });
    expect(forged.status).toBe(401);

    const cookie = await login("alice");
    expect(await (await request("GET", "/me", { cookie })).json()).toEqual({ user: "alice" });
    expect(await (await request("GET", "/social/accounts", { cookie })).json()).toEqual({ accounts: [] });

    const description = await json<Description>(request("GET", "/social/platforms", { cookie }));
    expect(description.publicUrl).toBe(`${base}/social`);
    const meta = description.connectors.find((c) => c.id === "meta");
    expect(meta).toMatchObject({ kind: "oauth", configured: false, redirectUri: `${base}/social/oauth/meta/callback` });
    expect(description.connectors.find((c) => c.id === "bluesky")).toMatchObject({ kind: "credentials", configured: true });

    // Unknown paths under the mount fall through to Express (its own 404), not the API's JSON 404.
    const missing = await request("GET", "/social/nope", { cookie });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type") ?? "").not.toContain("application/json");

    // Cross-site writes with the user's cookie are refused.
    const csrf = await request("POST", "/social/posts", { cookie, json: { text: "x" }, headers: { origin: "https://evil.example" } });
    expect(csrf.status).toBe(403);

    const out = await request("POST", "/logout", { cookie });
    expect(out.headers.getSetCookie()[0]).toMatch(/^demo_user=;/);
  });

  it("connects Bluesky, uploads media and publishes from its own route", async () => {
    const calls = stubBluesky();
    const cookie = await login("bob");

    const connected = await request("POST", "/social/connect/bluesky/credentials", {
      cookie,
      json: { fields: { identifier: handle, appPassword: "app-pass" } },
    });
    expect(connected.status).toBe(201);
    const { accounts } = await json<{ accounts: PublicAccount[] }>(connected);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ ownerId: "bob", platform: "bluesky", status: "active" });

    // Users only see their own accounts.
    const alice = await login("alice");
    expect(await (await request("GET", "/social/accounts", { cookie: alice })).json()).toEqual({ accounts: [] });

    // Multipart upload straight through the Express middleware chain (express.json() leaves it alone).
    const form = new FormData();
    form.append("file", new Blob([PNG], { type: "image/png" }), "dot.png");
    const uploaded = await request("POST", "/social/media", { cookie, body: form });
    expect(uploaded.status).toBe(201);
    const { media } = await json<{ media: PublicMedia[] }>(uploaded);
    expect(media[0]).toMatchObject({ kind: "image", mime: "image/png", size: PNG.length });
    expect(media[0].url.startsWith(`${base}/social/media/`)).toBe(true);

    // Signed media URLs are public (platforms download from them) and support ranges.
    const file = await realFetch(media[0].url, { headers: { range: "bytes=0-7" } });
    expect(file.status).toBe(206);
    expect(Buffer.from(await file.arrayBuffer()).equals(PNG.subarray(0, 8))).toBe(true);
    expect((await request("DELETE", `/social/media/${media[0].id}`, { cookie })).status).toBe(200);

    // The host's own route creates the post with sync.posts.create().
    expect((await request("POST", "/api/articles/launch/share")).status).toBe(401);
    expect((await request("POST", "/api/articles/nope/share", { cookie })).status).toBe(404);
    expect((await request("POST", "/api/articles/launch/share", { cookie: alice })).status).toBe(400);
    const shared = await request("POST", "/api/articles/launch/share", { cookie });
    expect(shared.status).toBe(201);
    const { post } = await json<{ post: PublicPost }>(shared);
    expect(post.text).toContain(`${base}/blog/launch`);
    expect(post.targets).toHaveLength(1);

    const { processed } = await host.sync.worker.runDue();
    expect(processed).toBe(1);
    const history = await json<PostPage>(request("GET", "/social/posts", { cookie }));
    expect(history.posts[0].targets[0]).toMatchObject({ status: "succeeded", remoteUrl: `https://bsky.app/profile/${handle}/post/3kq` });
    expect(logLines.some((l) => l.includes("published to bluesky"))).toBe(true);
    expect(calls.some((c) => c.startsWith(`POST ${PDS}/xrpc/com.atproto.repo.createRecord`))).toBe(true);
  });
});
