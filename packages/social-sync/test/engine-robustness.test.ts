/**
 * Engine robustness outside the worker: the posts cursor, scheduled times, deleting posts, the Postgres pool's error
 * listener, error text in log messages and token retries. Runs on SQLite and on Postgres (PGlite).
 */
import type { EventEmitter } from "node:events";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AuthError, RefreshAuthError } from "../src/http.js";
import { createHandler, createPostSync, type PostPage, type PostSync } from "../src/index.js";
import { errorText } from "../src/logger.js";
import { clearBlueskySessions } from "../src/platforms/bluesky.js";
import { withFreshToken } from "../src/platforms/common.js";
import { x } from "../src/platforms/x.js";
import { parseCursor } from "../src/posts.js";
import { postgresStorage } from "../src/storage/postgres.js";
import { sqliteStorage } from "../src/storage/sqlite.js";
import type { Storage } from "../src/storage/types.js";
import { makeCtx, mockFetch, tempDir, testConfig, TEST_SECRET, type Route } from "./helpers.js";
import { newPglite, pglitePool, type PglitePool } from "./pglite.js";

const BASE = "https://posts.example.com";
const PDS = "https://morel.us-east.host.bsky.network";
const YEAR = 365 * 86400_000;
// 1x1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function blueskyRoutes(): Route[] {
  return [
    {
      method: "POST",
      match: "https://bsky.social/xrpc/com.atproto.server.createSession",
      reply: () => ({
        json: {
          did: "did:plc:alice",
          handle: "alice.bsky.social",
          accessJwt: "JWT",
          didDoc: { service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: PDS }] },
        },
      }),
    },
    { method: "GET", match: `${PDS}/xrpc/app.bsky.actor.getProfile`, reply: () => ({ json: { displayName: "Alice" } }) },
  ];
}

let pglite: PGlite;
let pool: PglitePool;
let prefixes = 0;
beforeAll(async () => {
  pglite = await newPglite();
  pool = pglitePool(pglite);
}, 60_000);
afterAll(async () => pool?.end());

const backends: { name: string; storage: () => Storage }[] = [
  { name: "sqlite", storage: () => sqliteStorage(":memory:") },
  { name: "postgres", storage: () => postgresStorage(pool, { tablePrefix: `robust${++prefixes}_` }) },
];

describe.each(backends)("posts on $name", (backend) => {
  const engines: PostSync[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const s of engines.splice(0)) await s.close();
  });

  async function setup() {
    clearBlueskySessions();
    mockFetch(blueskyRoutes());
    const storage = backend.storage();
    const sync = await createPostSync({
      secret: TEST_SECRET,
      publicUrl: BASE,
      storage,
      mediaDir: tempDir(),
      logger: false,
      worker: { autoStart: false },
      sleep: async () => {},
    });
    engines.push(sync);
    const [account] = await sync.connect.withCredentials("alice", "bluesky", { identifier: "alice.bsky.social", appPassword: "p" });
    const handler = createHandler(sync, { authenticate: () => "alice" });
    const get = async (path: string) => {
      const res = await handler.fetch(new Request(new URL(path, BASE)));
      return { status: res.status, body: (await res.json()) as PostPage };
    };
    const post = (path: string, body: unknown) =>
      handler.fetch(new Request(new URL(path, BASE), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    return { sync, storage, accountId: account.id, get, post };
  }

  it("pages through posts created in the same millisecond without skipping or repeating any", async () => {
    const { sync, accountId, get } = await setup();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const created: string[] = [];
    for (let i = 0; i < 5; i++) created.push((await sync.posts.create("alice", { text: `Post ${i}`, targets: [{ accountId }] })).id);
    vi.restoreAllMocks();

    const seen: string[] = [];
    let before: string | null = null;
    for (let page = 0; page < 5; page++) {
      const result = await sync.posts.list("alice", { limit: 2, before });
      seen.push(...result.posts.map((p) => p.id));
      if (result.nextBefore) expect(result.nextBefore).toBe(`${now}_${result.posts[result.posts.length - 1].id}`);
      before = result.nextBefore;
      if (!before) break;
    }
    expect([...seen].sort()).toEqual([...created].sort());
    expect(seen).toHaveLength(5);

    // The same over HTTP, with the cursor URL-encoded or not.
    const first = await get("/posts?limit=2");
    expect(first.status).toBe(200);
    const second = await get(`/posts?limit=2&before=${encodeURIComponent(first.body.nextBefore!)}`);
    const third = await get(`/posts?limit=2&before=${second.body.nextBefore}`);
    const viaHttp = [first, second, third].flatMap((r) => r.body.posts.map((p) => p.id));
    expect(viaHttp).toEqual(seen);
    expect(third.body.nextBefore).toBeNull();
  });

  it("still takes a plain epoch-ms cursor and ignores garbage", async () => {
    const { sync, accountId, get } = await setup();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    for (let i = 0; i < 3; i++) await sync.posts.create("alice", { text: `Post ${i}`, targets: [{ accountId }] });
    vi.restoreAllMocks();

    expect((await sync.posts.list("alice", { before: String(now + 1) })).posts).toHaveLength(3);
    expect((await sync.posts.list("alice", { before: String(now) })).posts).toHaveLength(0);
    for (const garbage of ["abc", "12_", "-5", "1.5", "99999999999999999", "", null]) {
      expect((await sync.posts.list("alice", { before: garbage })).posts, String(garbage)).toHaveLength(3);
    }
    expect((await get(`/posts?before=${now + 1}`)).body.posts).toHaveLength(3);
    expect((await get("/posts?before=not-a-cursor")).body.posts).toHaveLength(3);
  });

  it("stores a fractional scheduledAt as whole milliseconds and refuses one more than 5 years ahead", async () => {
    const { sync, accountId, post } = await setup();
    const at = Date.now() + 3600_000 + 0.6;
    const scheduled = await sync.posts.create("alice", { text: "later", targets: [{ accountId }], scheduledAt: at });
    expect(scheduled.scheduledAt).toBe(Math.round(at));
    expect(scheduled.targets[0].runAt).toBe(Math.round(at));
    expect((await sync.posts.get("alice", scheduled.id))?.scheduledAt).toBe(Math.round(at));

    await expect(sync.posts.create("alice", { text: "x", targets: [{ accountId }], scheduledAt: Date.now() + 6 * YEAR })).rejects.toThrow(/5 years/);
    await expect(sync.posts.create("alice", { text: "x", targets: [{ accountId }], scheduledAt: 1e300 })).rejects.toThrow(/5 years/);
    await expect(sync.posts.create("alice", { text: "x", targets: [{ accountId }], scheduledAt: "+275000-01-01T00:00:00Z" })).rejects.toThrow(
      /5 years/,
    );
    expect((await post("/posts", { text: "x", targets: [{ accountId }], scheduledAt: 1e300 })).status).toBe(400);
    expect((await sync.posts.create("alice", { text: "soon", targets: [{ accountId }], scheduledAt: Date.now() + 4 * YEAR })).scheduledAt).toBeTypeOf(
      "number",
    );
  });

  it("refuses to delete a post while one of its jobs runs, then deletes it with its unused media", async () => {
    const { sync, storage, accountId } = await setup();
    const media = await sync.media.fromBuffer("alice", PNG, "dot.png");
    const created = await sync.posts.create("alice", { text: "hi", mediaIds: [media.id], targets: [{ accountId }] });
    const [running] = await storage.claimDueTargets(10, Date.now(), Date.now() + 60_000);
    expect(running.post_id).toBe(created.id);

    expect(await sync.posts.remove("bob", created.id)).toBe("not_found");
    expect(await sync.posts.remove("alice", created.id)).toBe("running");
    expect(await sync.posts.get("alice", created.id)).not.toBeNull();
    expect(await sync.media.get("alice", media.id)).not.toBeNull();

    await storage.completeTarget(running.id, "remote-1", null, null);
    expect(await sync.posts.remove("alice", created.id)).toBe("deleted");
    expect(await sync.posts.get("alice", created.id)).toBeNull();
    expect(await sync.media.get("alice", media.id)).toBeNull();
    expect(await sync.posts.remove("alice", created.id)).toBe("not_found");
  });
});

// ---- the Postgres pool ------------------------------------------------------------------------------------

describe("postgresStorage with a connection string", () => {
  const URL = "postgres://user:secret@127.0.0.1:1/none";
  /** The pool the storage created (it connects lazily, so no database is needed). */
  const poolOf = (s: Storage) => (s as unknown as { pool(): Promise<EventEmitter> }).pool();

  afterEach(() => vi.restoreAllMocks());

  it("listens for errors of idle connections, so a dropped connection can't crash the host", async () => {
    const errors: string[] = [];
    const s = postgresStorage(URL, { onError: (err) => errors.push(err.message) });
    const created = await poolOf(s);
    expect(created.listenerCount("error")).toBe(1);
    // Without a listener, emitting "error" throws (and in a real pool, crashes the process).
    expect(() => created.emit("error", new Error("terminating connection due to administrator command"))).not.toThrow();
    expect(errors).toEqual(["terminating connection due to administrator command"]);
    await s.close();
  });

  it("logs them by default, and survives a throwing handler", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = postgresStorage(URL);
    const created = await poolOf(s);
    created.emit("error", new Error("Connection terminated unexpectedly"));
    expect(logged).toHaveBeenCalledWith("[post-sync] PostgreSQL connection error: Connection terminated unexpectedly", expect.any(Error));
    await s.close();

    const throwing = postgresStorage(URL, {
      onError: () => {
        throw new Error("handler bug");
      },
    });
    const other = await poolOf(throwing);
    expect(() => other.emit("error", new Error("boom"))).not.toThrow();
    await throwing.close();
  });

  it("leaves a pool the host passes in alone", async () => {
    const s = postgresStorage(pool);
    expect(await poolOf(s)).toBe(pool);
  });
});

// ---- small pieces -------------------------------------------------------------------------------------------

describe("errorText", () => {
  it("turns anything thrown into text for the log message", () => {
    expect(errorText(new Error("boom"))).toBe("boom");
    expect(errorText(new TypeError(""))).toBe("TypeError");
    expect(errorText("plain")).toBe("plain");
    expect(errorText(42)).toBe("42");
    expect(errorText(null)).toBe("null");
    expect(errorText(undefined)).toBe("undefined");
  });
});

describe("parseCursor", () => {
  it("reads <createdAt>_<id>, a bare number, and nothing else", () => {
    expect(parseCursor("1700000000000_3f1c-ab")).toEqual({ createdAt: 1_700_000_000_000, id: "3f1c-ab" });
    expect(parseCursor("1700000000000_a_b")).toEqual({ createdAt: 1_700_000_000_000, id: "a_b" });
    expect(parseCursor(" 1700000000000 ")).toEqual({ createdAt: 1_700_000_000_000, id: "" });
    expect(parseCursor(1_700_000_000_000)).toEqual({ createdAt: 1_700_000_000_000, id: "" });
    for (const bad of ["", "abc", "_id", "12_", "-1", "1.5", "1e12", "99999999999999999", `1_${"x".repeat(201)}`, null, undefined, NaN, -1, 1.5, {}]) {
      expect(parseCursor(bad), String(bad)).toBeUndefined();
    }
  });
});

describe("withFreshToken", () => {
  const config = testConfig();

  it("forces one refresh after a 401", async () => {
    const ctx = makeCtx(x, { config, credentials: {}, input: {} });
    const forced: boolean[] = [];
    ctx.credentials = async (opts) => (forced.push(!!opts?.force), { accessToken: opts?.force ? "new" : "old" });
    const tokens: string[] = [];
    const result = await withFreshToken(ctx, (c) => c.accessToken, async (token) => {
      tokens.push(token);
      if (token === "old") throw new AuthError("401");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(tokens).toEqual(["old", "new"]);
    expect(forced).toEqual([false, true]);
  });

  it("doesn't refresh again when the refresh itself was rejected", async () => {
    const ctx = makeCtx(x, { config, credentials: {}, input: {} });
    let calls = 0;
    ctx.credentials = async () => {
      calls++;
      throw new RefreshAuthError("X rejected the saved login. Reconnect the account.");
    };
    const fn = vi.fn(async () => "never");
    await expect(withFreshToken(ctx, (c) => c.accessToken, fn)).rejects.toBeInstanceOf(RefreshAuthError);
    expect(calls).toBe(1);
    expect(fn).not.toHaveBeenCalled();
    expect(new RefreshAuthError("x")).toBeInstanceOf(AuthError);
  });
});
