/**
 * OAuth logins are bound to the browser (or logged-in owner) that started them, so a login URL sent to someone else
 * can't put their social accounts into the sender's tenant.
 */
import crypto from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPostSyncClient, PostSyncClientError } from "../src/client/index.js";
import {
  ConnectError,
  createHandler,
  createPostSync,
  UserError,
  type PostSync,
  type PostSyncHandler,
  type RequestContext,
  type Storage,
} from "../src/index.js";
import { postgresStorage } from "../src/storage/postgres.js";
import { sqliteStorage } from "../src/storage/sqlite.js";
import { mockFetch, tempDir, TEST_SECRET, type Route } from "./helpers.js";
import { newPglite, pglitePool } from "./pglite.js";

const ORIGIN = "https://app.example.com";
const BASE = `${ORIGIN}/social`;
const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

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

async function makeSync(storage: Storage = sqliteStorage(":memory:"), publicUrl = BASE): Promise<PostSync> {
  return createPostSync({
    secret: TEST_SECRET,
    publicUrl,
    storage,
    mediaDir: tempDir(),
    logger: false,
    worker: { autoStart: false },
    platforms: { meta: { appId: "meta-app", appSecret: "meta-secret" } },
  });
}

interface CallInit {
  /** Value of the x-user header (the host app's login). Default: nobody. */
  user?: string | null;
  cookie?: string;
  json?: unknown;
  context?: RequestContext;
}

function call(h: PostSyncHandler, method: string, path: string, init: CallInit = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.user) headers["x-user"] = init.user;
  if (init.cookie) headers.cookie = init.cookie;
  let body: string | undefined;
  if (init.json !== undefined) {
    body = JSON.stringify(init.json);
    headers["content-type"] = "application/json";
  }
  return h.fetch(new Request(/^https?:/.test(path) ? path : BASE + path, { method, headers, body }), init.context);
}

const params = (res: Response) => Object.fromEntries(new URL(res.headers.get("location")!).searchParams);
const exchanges = (calls: { url: URL }[]) => calls.filter((c) => c.url.pathname.endsWith("/oauth/access_token")).length;

describe("OAuth browser binding", () => {
  let sync: PostSync;
  let handler: PostSyncHandler;
  let storage: Storage;

  beforeEach(async () => {
    storage = sqliteStorage(":memory:");
    sync = await makeSync(storage);
    handler = createHandler(sync, { authenticate: (request) => request.headers.get("x-user") });
  });
  afterEach(async () => sync.close());

  /** Starts a Meta login as `user`. Returns the state and the binding cookie the starting browser received. */
  async function start(user: string, how: "GET" | "POST" = "POST", returnTo = "/settings") {
    const res =
      how === "POST"
        ? await call(handler, "POST", "/connect/meta", { user, json: { returnTo } })
        : await call(handler, "GET", `/connect/meta?returnTo=${encodeURIComponent(returnTo)}`, { user });
    const authUrl = how === "POST" ? ((await res.json()) as any).url : res.headers.get("location");
    const setCookie = res.headers.get("set-cookie") ?? "";
    return { state: new URL(authUrl).searchParams.get("state")!, setCookie, cookie: setCookie.split(";")[0] };
  }

  /** The platform sends a browser back to the callback (with whatever cookies and login that browser has). */
  const callback = (state: string, init: CallInit = {}) =>
    call(handler, "GET", `/oauth/meta/callback?code=CODE&state=${encodeURIComponent(state)}`, init);

  const confirm = (user: string | null, token: unknown) => call(handler, "POST", "/connect/confirm", { user, json: { confirm: token } });

  describe("the binding cookie", () => {
    it("is HttpOnly, SameSite=Lax, scoped to the callbacks, Secure on https, and only its hash is stored", async () => {
      for (const how of ["POST", "GET"] as const) {
        const { state, setCookie } = await start("alice", how);
        const [pair, ...attrs] = setCookie.split("; ");
        expect(pair).toMatch(/^postsync_oauth=[\w-]{40,}$/);
        expect(attrs).toEqual(["Max-Age=1800", "Path=/social/oauth/", "HttpOnly", "SameSite=Lax", "Secure"]);
        const row = (await storage.takeOAuthState(state, 0))!;
        expect(row.binding).toBe(sha256(pair.split("=")[1]));
        expect(row.callback_query).toBeNull();
      }
      // Never cached (a shared cache must not hand the cookie to someone else).
      expect((await call(handler, "GET", "/connect/meta", { user: "alice" })).headers.get("cache-control")).toBe("no-store");
    });

    it("has no Secure flag on plain http and follows publicUrl's path", async () => {
      const local = await makeSync(sqliteStorage(":memory:"), "http://localhost:3000");
      try {
        const h = createHandler(local, { authenticate: () => "alice" });
        const res = await h.fetch(new Request("http://localhost:3000/connect/meta", { method: "POST" }));
        expect(res.status).toBe(200);
        expect(res.headers.get("set-cookie")).toMatch(/^postsync_oauth=[\w-]+; Max-Age=1800; Path=\/oauth\/; HttpOnly; SameSite=Lax$/);
      } finally {
        await local.close();
      }
    });

    it("isn't set when the login can't start", async () => {
      const res = await call(handler, "GET", "/connect/tiktok", { user: "alice" });
      expect(params(res).postsync).toBe("error");
      expect(res.headers.get("set-cookie")).toBeNull();
      expect((await call(handler, "POST", "/connect/nope", { user: "alice", json: {} })).headers.get("set-cookie")).toBeNull();
    });
  });

  it("connects directly when the callback carries the starting browser's cookie, and clears the cookie", async () => {
    const { calls } = mockFetch(metaRoutes());
    const { state, cookie } = await start("alice");
    const res = await callback(state, { cookie: `theme=dark; ${cookie}; other=1` });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/settings");
    expect(params(res)).toEqual({ postsync: "connected", connector: "Facebook & Instagram", count: "1" });
    expect(res.headers.get("set-cookie")).toBe("postsync_oauth=; Max-Age=0; Path=/social/oauth/; HttpOnly; SameSite=Lax; Secure");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await sync.accounts.list("alice")).map((a) => a.platform)).toEqual(["facebook"]);
    expect(exchanges(calls)).toBeGreaterThan(0);
  });

  it("connects directly when the owner who started it is logged in (no cookie needed)", async () => {
    mockFetch(metaRoutes());
    const { state } = await start("alice");
    expect(params(await callback(state, { user: "alice" })).postsync).toBe("connected");
    expect(await sync.accounts.list("alice")).toHaveLength(1);
  });

  it("uses the adapter's getOwnerId on the callback", async () => {
    mockFetch(metaRoutes());
    const { state } = await start("alice");
    expect(params(await callback(state, { context: { getOwnerId: async () => "alice" } })).postsync).toBe("connected");
    const other = await start("alice");
    const refused = await callback(other.state, { cookie: other.cookie, context: { getOwnerId: () => "bob" } });
    expect(params(refused)).toMatchObject({ postsync: "error", error: expect.stringMatching(/started by a different user/) });
  });

  describe("a login URL sent to someone else", () => {
    it("never saves the victim's accounts to the sender, and only the sender's own confirm could finish it", async () => {
      const { fn } = mockFetch(metaRoutes());
      // Mallory starts a login and sends the platform URL to a victim, who approves it in their own browser:
      // no binding cookie, not logged in to the host app.
      const mallory = await start("mallory");
      const res = await callback(mallory.state);
      const back = params(res);
      expect(back).toMatchObject({ postsync: "confirm", connector: "Facebook & Instagram" });
      expect(back.confirm).toMatch(/^[\w-]{40,}$/);
      expect(back.count).toBeUndefined();
      expect(res.headers.get("set-cookie")).toMatch(/^postsync_oauth=; Max-Age=0;/);
      // Nothing was exchanged or saved.
      expect(fn).not.toHaveBeenCalled();
      expect(await sync.accounts.list("mallory")).toEqual([]);

      // Mallory can't finish it without the token (it stays with the victim's browser)...
      expect((await confirm("mallory", undefined)).status).toBe(400);
      expect((await confirm("mallory", "made-up")).status).toBe(400);
      expect((await confirm("mallory", mallory.state)).status).toBe(400);
      // ...nor replay the callback.
      expect(params(await callback(mallory.state, { cookie: mallory.cookie })).error).toMatch(/expired or was already used/);

      // The victim's page confirms as the victim: refused, and the token is used up.
      const victim = await confirm("victim", back.confirm);
      expect(victim.status).toBe(403);
      expect(await victim.json()).toEqual({ error: "This login was started by a different user." });
      const late = await confirm("mallory", back.confirm);
      expect(late.status).toBe(400);
      expect(((await late.json()) as any).error).toMatch(/expired or was already finished/);

      expect(fn).not.toHaveBeenCalled();
      expect(await sync.accounts.list("mallory")).toEqual([]);
      expect(await sync.accounts.list("victim")).toEqual([]);
    });

    it("is refused at the callback when the victim is logged in to the host app", async () => {
      const { fn } = mockFetch(metaRoutes());
      const mallory = await start("mallory");
      const res = await callback(mallory.state, { user: "victim" });
      expect(params(res)).toEqual({
        postsync: "error",
        connector: "Facebook & Instagram",
        error: "This login was started by a different user. Start it again from your account.",
      });
      expect(fn).not.toHaveBeenCalled();
      // The state is used up.
      expect(params(await callback(mallory.state)).postsync).toBe("error");
      expect(await sync.accounts.list("mallory")).toEqual([]);
    });

    it("doesn't count a binding cookie from another login", async () => {
      const { fn } = mockFetch(metaRoutes());
      const mallory = await start("mallory");
      const victimsOwn = await start("victim");
      expect(params(await callback(mallory.state, { cookie: victimsOwn.cookie })).postsync).toBe("confirm");
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe("confirming", () => {
    it("lets the owner who started the login finish it (e.g. cookies blocked or another tab)", async () => {
      const { calls } = mockFetch(metaRoutes());
      const { state } = await start("alice", "POST", "/settings?tab=accounts");
      const res = await callback(state);
      expect(new URL(res.headers.get("location")!).pathname).toBe("/settings");
      const { confirm: token, ...rest } = params(res);
      expect(rest).toEqual({ tab: "accounts", postsync: "confirm", connector: "Facebook & Instagram" });
      expect(calls).toHaveLength(0);

      const done = await confirm("alice", token);
      expect(done.status).toBe(200);
      const body = (await done.json()) as any;
      expect(body.connector).toBe("Facebook & Instagram");
      expect(body.accounts.map((a: any) => [a.platform, a.ownerId])).toEqual([["facebook", "alice"]]);
      const exchange = calls.find((c) => c.url.pathname.endsWith("/oauth/access_token"))!;
      expect(exchange.url.searchParams.get("code")).toBe("CODE");
      expect(exchange.url.searchParams.get("redirect_uri")).toBe(`${BASE}/oauth/meta/callback`);
      expect(await sync.accounts.list("alice")).toHaveLength(1);

      // Single use.
      expect((await confirm("alice", token)).status).toBe(400);
    });

    it("needs a login, a token, and a token that hasn't expired", async () => {
      mockFetch(metaRoutes());
      const { state } = await start("alice");
      const token = params(await callback(state)).confirm;
      expect((await confirm(null, token)).status).toBe(401);
      const missing = await call(handler, "POST", "/connect/confirm", { user: "alice", json: {} });
      expect(missing.status).toBe(400);
      expect(((await missing.json()) as any).error).toMatch(/Send \{ confirm \}/);

      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + 31 * 60_000);
      const expired = await confirm("alice", token);
      expect(expired.status).toBe(400);
      expect(((await expired.json()) as any).error).toBe("That login expired or was already finished. Connect again.");
      expect(await sync.accounts.list("alice")).toEqual([]);
    });

    it("reports the platform refusing the code and uses the token up", async () => {
      mockFetch([
        {
          match: "https://graph.facebook.com/v26.0/oauth/access_token",
          reply: () => ({ status: 400, json: { error: { message: "Invalid verification code", code: 100 } } }),
        },
      ]);
      const { state } = await start("alice");
      const token = params(await callback(state)).confirm;
      const res = await confirm("alice", token);
      expect(res.status).toBe(502);
      expect(((await res.json()) as any).error).toMatch(/^Connecting Facebook & Instagram failed: .*Invalid verification code/);
      expect((await confirm("alice", token)).status).toBe(400);
    });

    it("isn't confused with a connector called confirm", async () => {
      expect((await call(handler, "POST", "/connect/confirm", { user: "alice", json: { returnTo: "/x" } })).status).toBe(400);
      const nav = await call(handler, "GET", "/connect/confirm", { user: "alice" });
      expect(params(nav)).toMatchObject({ postsync: "error", connector: "confirm", error: 'Unknown connector "confirm".' });
      await expect(sync.connect.start("alice", "confirm")).rejects.toThrow(UserError);
    });
  });

  it("treats a failing authenticate hook on the callback as nobody logged in", async () => {
    const { fn } = mockFetch(metaRoutes());
    const h = createHandler(sync, {
      authenticate: (request) => {
        if (request.url.includes("/oauth/")) throw Object.assign(new Error("no session"), { status: 401 });
        return request.headers.get("x-user");
      },
    });
    const started = await call(h, "POST", "/connect/meta", { user: "alice", json: {} });
    const state = new URL(((await started.json()) as any).url).searchParams.get("state")!;
    const res = await call(h, "GET", `/oauth/meta/callback?code=CODE&state=${state}`);
    expect(res.status).toBe(302);
    expect(params(res).postsync).toBe("confirm");
    expect(fn).not.toHaveBeenCalled();
  });

  describe("engine API", () => {
    const query = (state: string) => ({ code: "CODE", state });
    const begin = async (owner: string, binding?: string) =>
      new URL((await sync.connect.start(owner, "meta", { returnTo: `${ORIGIN}/back`, binding })).url).searchParams.get("state")!;

    it("returns connected only for a matching binding or the same owner", async () => {
      mockFetch(metaRoutes());
      const viaBinding = await sync.connect.complete("meta", query(await begin("alice", "b")), { binding: "b" });
      expect(viaBinding).toMatchObject({ status: "connected", ownerId: "alice", returnTo: `${ORIGIN}/back`, connector: "Facebook & Instagram" });
      expect(viaBinding.status === "connected" && viaBinding.accounts).toHaveLength(1);
      expect(await sync.connect.complete("meta", query(await begin("alice")), { ownerId: "alice" })).toMatchObject({ status: "connected" });

      for (const opts of [undefined, {}, { binding: "other" }, { binding: null, ownerId: null }]) {
        const result = await sync.connect.complete("meta", query(await begin("alice", "b")), opts);
        expect(result).toEqual({
          status: "confirm",
          confirmToken: expect.any(String),
          returnTo: `${ORIGIN}/back`,
          connector: "Facebook & Instagram",
        });
      }
      // No binding was stored: a binding given at the callback proves nothing.
      expect((await sync.connect.complete("meta", query(await begin("alice")), { binding: "" })).status).toBe("confirm");
    });

    it("refuses another logged-in owner even with the right binding", async () => {
      const state = await begin("alice", "b");
      const err = await sync.connect.complete("meta", query(state), { binding: "b", ownerId: "bob" }).catch((e) => e);
      expect(err).toBeInstanceOf(ConnectError);
      expect(err.message).toMatch(/started by a different user/);
      expect(err.returnTo).toBe(`${ORIGIN}/back`);
    });

    it("confirms for the owner only, once", async () => {
      mockFetch(metaRoutes());
      const result = await sync.connect.complete("meta", query(await begin("alice")));
      if (result.status !== "confirm") throw new Error("expected confirm");
      const wrong = await sync.connect.confirm("bob", result.confirmToken).catch((e) => e);
      expect(wrong).toBeInstanceOf(UserError);
      expect(wrong.status).toBe(403);
      await expect(sync.connect.confirm("alice", result.confirmToken)).rejects.toThrow(/expired or was already finished/);

      const again = await sync.connect.complete("meta", query(await begin("alice")));
      if (again.status !== "confirm") throw new Error("expected confirm");
      const done = await sync.connect.confirm("alice", again.confirmToken);
      expect(done).toEqual({
        accounts: [expect.objectContaining({ platform: "facebook", ownerId: "alice" })],
        connector: "Facebook & Instagram",
        returnTo: `${ORIGIN}/back`,
      });
      await expect(sync.connect.confirm("alice", "")).rejects.toThrow(UserError);
    });

    it("never takes a waiting confirmation through the callback", async () => {
      const result = await sync.connect.complete("meta", query(await begin("alice")));
      if (result.status !== "confirm") throw new Error("expected confirm");
      const stateOfRow = `confirm:${sha256(result.confirmToken)}`;
      await expect(sync.connect.complete("meta", query(stateOfRow), { ownerId: "alice" })).rejects.toThrow(/expired or was already used/);
      mockFetch(metaRoutes());
      expect((await sync.connect.confirm("alice", result.confirmToken)).accounts).toHaveLength(1);
    });
  });

  describe("client SDK", () => {
    const client = (user: string) =>
      createPostSyncClient({
        baseUrl: BASE,
        headers: { "x-user": user },
        fetch: ((input: string | URL | Request, init?: RequestInit) => handler.fetch(new Request(input, init))) as typeof fetch,
      });

    it("finish() returns connected results as they are and confirms the others", async () => {
      mockFetch(metaRoutes());
      const alice = client("alice");
      const connected = await alice.connect.finish("?postsync=connected&connector=LinkedIn&count=2");
      expect(connected).toEqual({ status: "connected", connector: "LinkedIn", count: 2 });
      expect(await alice.connect.finish("?postsync=error&connector=X&error=Nope")).toEqual({ status: "error", connector: "X", error: "Nope" });
      expect(await alice.connect.finish("?tab=1")).toBeNull();

      const { url } = await alice.connect.start("meta", { returnTo: "/settings" });
      const page = new URL((await callback(new URL(url).searchParams.get("state")!)).headers.get("location")!);
      const parsed = alice.connect.parseResult(page.search);
      expect(parsed).toEqual({ status: "confirm", connector: "Facebook & Instagram", confirm: expect.stringMatching(/^[\w-]{40,}$/) });
      expect(await alice.connect.finish(page.search)).toEqual({ status: "connected", connector: "Facebook & Instagram", count: 1 });
      expect(await alice.accounts.list()).toHaveLength(1);

      // Used up.
      const again = await alice.connect.finish(page.search).catch((e) => e);
      expect(again).toBeInstanceOf(PostSyncClientError);
      expect(again.status).toBe(400);
    });

    it("finish() throws when someone else's login is confirmed; confirm() returns the accounts", async () => {
      mockFetch(metaRoutes());
      const { url } = await client("mallory").connect.start("meta");
      const search = new URL((await callback(new URL(url).searchParams.get("state")!)).headers.get("location")!).search;
      const err = await client("victim").connect.finish(search).catch((e) => e);
      expect(err).toBeInstanceOf(PostSyncClientError);
      expect(err.status).toBe(403);

      const second = await client("alice").connect.start("meta");
      const token = new URL((await callback(new URL(second.url).searchParams.get("state")!)).headers.get("location")!).searchParams.get("confirm")!;
      expect((await client("alice").connect.confirm(token)).map((a) => a.platform)).toEqual(["facebook"]);
    });

    it("finish() reads the page's location by default", async () => {
      vi.stubGlobal("location", { search: "?postsync=connected&connector=TikTok&count=1" });
      expect(await client("alice").connect.finish()).toEqual({ status: "connected", connector: "TikTok", count: 1 });
    });
  });
});

describe("oauth_states upgrade", () => {
  const OLD_TABLE = (name: string) =>
    `CREATE TABLE ${name} (state TEXT PRIMARY KEY, owner_id TEXT NOT NULL, connector TEXT NOT NULL, code_verifier TEXT, return_to TEXT,
       created_at BIGINT NOT NULL)`;
  const row = (state: string) => ({
    state,
    owner_id: "alice",
    connector: "meta",
    code_verifier: null,
    return_to: null,
    binding: "hash",
    callback_query: '{"code":"c"}',
    created_at: Date.now(),
  });

  it("adds the new columns to an existing SQLite table", async () => {
    const file = path.join(tempDir(), "old.db");
    const db = new Database(file);
    db.exec(OLD_TABLE("postsync_oauth_states"));
    db.prepare("INSERT INTO postsync_oauth_states VALUES ('old', 'alice', 'meta', NULL, NULL, ?)").run(Date.now());
    db.close();

    const storage = sqliteStorage(file);
    try {
      await storage.migrate();
      await storage.migrate();
      expect(await storage.takeOAuthState("old", 0)).toMatchObject({ state: "old", binding: null, callback_query: null });
      const fresh = row("new");
      await storage.saveOAuthState(fresh);
      expect(await storage.takeOAuthState("new", 0)).toEqual(fresh);
    } finally {
      await storage.close();
    }
  });

  describe("Postgres", () => {
    let pglite: PGlite;
    beforeAll(async () => {
      pglite = await newPglite();
    }, 60_000);
    afterAll(async () => pglite?.close());

    it("adds the new columns to an existing table", async () => {
      const pool = pglitePool(pglite);
      await pool.query(OLD_TABLE("up_postsync_oauth_states"));
      await pool.query("INSERT INTO up_postsync_oauth_states VALUES ('old', 'alice', 'meta', NULL, NULL, $1)", [Date.now()]);
      const storage = postgresStorage(pool, { tablePrefix: "up_postsync_" });
      await storage.migrate();
      await storage.migrate();
      expect(await storage.takeOAuthState("old", 0)).toMatchObject({ state: "old", binding: null, callback_query: null });
      const fresh = row("new");
      await storage.saveOAuthState(fresh);
      expect(await storage.takeOAuthState("new", 0)).toEqual(fresh);
      await storage.close();
    });

    it("binds logins on a fresh database", async () => {
      const storage = postgresStorage(pglitePool(pglite), { tablePrefix: "fresh_postsync_" });
      const sync = await makeSync(storage);
      try {
        mockFetch(metaRoutes());
        const start = async () => new URL((await sync.connect.start("alice", "meta", { binding: "b" })).url).searchParams.get("state")!;
        expect((await sync.connect.complete("meta", { code: "C", state: await start() }, { binding: "b" })).status).toBe("connected");
        const waiting = await sync.connect.complete("meta", { code: "C", state: await start() });
        if (waiting.status !== "confirm") throw new Error("expected confirm");
        await expect(sync.connect.confirm("bob", waiting.confirmToken)).rejects.toMatchObject({ status: 403 });
      } finally {
        await sync.close();
      }
    });
  });
});
