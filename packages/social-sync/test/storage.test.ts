import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPostSync, type PostSync } from "../src/index.js";
import { clearBlueskySessions } from "../src/platforms/bluesky.js";
import { postgresStorage } from "../src/storage/postgres.js";
import { newId } from "../src/storage/schema.js";
import { sqliteStorage } from "../src/storage/sqlite.js";
import type { MediaRow, NewAccount, PostRow, Storage, TargetRow } from "../src/storage/types.js";
import type { PublicAccount, PublicPost } from "../src/types.js";
import { mockFetch, tempDir, TEST_SECRET, type MockCall } from "./helpers.js";
import { newPglite, pglitePool, type PglitePool } from "./pglite.js";

// Past 2^31, so BIGINT columns matter.
const T0 = 1_700_000_000_000;
const LEASE = 120_000;

// ---- backends --------------------------------------------------------------------------------

interface TestDatabase {
  /** A storage over this database (not migrated yet). */
  open(options?: { tablePrefix?: string; schema?: string }): Storage;
}

interface Backend {
  name: "sqlite" | "postgres";
  /** A new, empty database that several storages can share. */
  database(): TestDatabase;
  /** A storage with a database of its own (not migrated yet). */
  single(): Storage;
}

const opened: Storage[] = [];
function track(s: Storage): Storage {
  opened.push(s);
  return s;
}

const sqlite: Backend = {
  name: "sqlite",
  database() {
    const file = path.join(tempDir(), "post-sync.db");
    return { open: (o = {}) => track(sqliteStorage(file, { tablePrefix: o.tablePrefix })) };
  },
  single: () => track(sqliteStorage(":memory:")),
};

// One PGlite for the whole file (it takes seconds to start); every test database gets its own table prefix.
let pglite: PGlite;
let pool: PglitePool;
let databases = 0;
const postgres: Backend = {
  name: "postgres",
  database() {
    const ns = `t${++databases}_`;
    return { open: (o = {}) => track(postgresStorage(pool, { tablePrefix: ns + (o.tablePrefix ?? "postsync_"), schema: o.schema })) };
  },
  single: () => postgres.database().open(),
};

beforeAll(async () => {
  pglite = await newPglite();
  pool = pglitePool(pglite);
}, 60_000);
afterAll(async () => pool?.end());
afterEach(async () => {
  for (const s of opened.splice(0)) await s.close().catch(() => {});
});

// ---- rows ------------------------------------------------------------------------------------

let seq = 0;

function account(over: Partial<NewAccount> = {}): NewAccount {
  return {
    owner_id: "alice",
    platform: "bluesky",
    connector: "bluesky",
    external_id: `ext-${++seq}`,
    name: "Alice",
    username: "alice",
    avatar_url: null,
    credentials: "encrypted",
    meta: "{}",
    grant_id: null,
    expires_at: null,
    ...over,
  };
}

function media(over: Partial<MediaRow> = {}): MediaRow {
  const id = over.id ?? newId();
  return {
    id,
    owner_id: "alice",
    filename: "photo.jpg",
    file: `${id}.jpg`,
    mime: "image/jpeg",
    kind: "image",
    size: 1234,
    width: 1200,
    height: 800,
    duration: null,
    created_at: T0,
    ...over,
  };
}

function post(over: Partial<PostRow> = {}): PostRow {
  return { id: newId(), owner_id: "alice", text: "hello", title: null, media_ids: "[]", scheduled_at: null, created_at: T0, ...over };
}

function target(p: PostRow, accountId: string, over: Partial<TargetRow> = {}): TargetRow {
  return {
    id: newId(),
    post_id: p.id,
    owner_id: p.owner_id,
    account_id: accountId,
    account_name: "Alice",
    platform: "bluesky",
    text_override: null,
    options: "{}",
    status: "queued",
    attempts: 0,
    run_at: T0,
    lease_until: null,
    progress: null,
    error: null,
    remote_id: null,
    remote_url: null,
    started_at: null,
    finished_at: null,
    created_at: T0,
    updated_at: T0,
    ...over,
  };
}

/** A post with one target for `accountId`. */
async function enqueue(s: Storage, accountId: string, over: Partial<TargetRow> = {}, ownerId = "alice"): Promise<TargetRow> {
  const p = post({ owner_id: ownerId });
  const t = target(p, accountId, over);
  await s.insertPost(p, [t]);
  return t;
}

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
const sorted = (values: string[]) => [...values].sort();

// BIGINT/DOUBLE columns: pg returns BIGINT as strings, the storage must turn them back into numbers.
const NUMERIC = new Set([
  "expires_at",
  "created_at",
  "updated_at",
  "size",
  "width",
  "height",
  "duration",
  "scheduled_at",
  "attempts",
  "run_at",
  "lease_until",
  "started_at",
  "finished_at",
]);

function expectNumeric(row: object | undefined): void {
  expect(row).toBeDefined();
  for (const [key, value] of Object.entries(row!)) {
    if (NUMERIC.has(key) && value !== null) expect(typeof value, key).toBe("number");
  }
}

/** The rows as they are stored now. */
async function stored(s: Storage, rows: TargetRow[]): Promise<(TargetRow | undefined)[]> {
  return Promise.all(rows.map((r) => s.getTarget(null, r.id)));
}

// ---- the contract ----------------------------------------------------------------------------

describe.each([sqlite, postgres])("$name storage", (backend) => {
  async function fresh(): Promise<Storage> {
    const s = backend.single();
    await s.migrate();
    return s;
  }

  describe("schema", () => {
    it("migrate is idempotent and keeps the data", async () => {
      const s = await fresh();
      const id = await s.upsertAccount(account());
      await s.migrate();
      await s.migrate();
      expect((await s.getAccount(null, id))?.id).toBe(id);
    });

    it("keeps storages with different table prefixes apart in one database", async () => {
      const db = backend.database();
      const a = db.open({ tablePrefix: "a_" });
      const b = db.open({ tablePrefix: "b_" });
      await a.migrate();
      await b.migrate();

      const acc = account();
      const accountId = await a.upsertAccount(acc);
      const m = media();
      await a.insertMedia(m);
      const p = post({ media_ids: JSON.stringify([m.id]) });
      const t = target(p, accountId);
      await a.insertPost(p, [t]);

      expect(await b.listAccounts("alice")).toEqual([]);
      expect(await b.getMedia(null, m.id)).toBeUndefined();
      expect(await b.isMediaReferenced(m.id)).toBe(false);
      expect(await b.listPosts("alice", 10)).toEqual([]);
      expect(await b.claimDueTargets(10, T0, T0 + LEASE)).toEqual([]);

      // The same ids don't collide across prefixes.
      await b.upsertAccount(acc);
      await b.insertMedia(m);
      await b.insertPost(p, [t]);
      expect(ids(await a.claimDueTargets(10, T0, T0 + LEASE))).toEqual([t.id]);
      expect((await b.getTarget(null, t.id))?.status).toBe("queued");
      expect(ids(await b.claimDueTargets(10, T0, T0 + LEASE))).toEqual([t.id]);

      expect(() => db.open({ tablePrefix: "bad-prefix" })).toThrow(/tablePrefix/);
    });

    it("lets several storages migrate one database at the same time", async () => {
      const db = backend.database();
      const storages = Array.from({ length: 4 }, () => db.open());
      await Promise.all(storages.map((s) => s.migrate()));
      await Promise.all(storages.map((s) => s.migrate()));
      const id = await storages[0].upsertAccount(account());
      expect((await storages[3].getAccount("alice", id))?.id).toBe(id);
    });

    it.runIf(backend.name === "postgres")("creates the tables in the given Postgres schema", async () => {
      const db = backend.database();
      const schema = `tenant_${++seq}`;
      const inSchema = db.open({ schema });
      const inDefault = db.open();
      await inSchema.migrate();
      await inSchema.migrate();
      await inDefault.migrate();

      const id = await inSchema.upsertAccount(account());
      expect((await inSchema.getAccount("alice", id))?.id).toBe(id);
      expect(await inDefault.listAccounts("alice")).toEqual([]);
      await enqueue(inSchema, "acc-1");
      expect(await inSchema.claimDueTargets(10, T0, T0 + LEASE)).toHaveLength(1);

      const tables = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = $1", [schema]);
      expect(tables.rows).toHaveLength(6);
      const indexes = await pool.query("SELECT indexname FROM pg_indexes WHERE schemaname = $1", [schema]);
      expect(indexes.rows.map((r) => r.indexname)).toContainEqual(expect.stringMatching(/_targets_one_running$/));

      expect(() => postgresStorage(pool, { schema: "x; DROP TABLE y" })).toThrow(/schema/);
    });
  });

  describe("accounts", () => {
    it("upserts by owner, platform and external id, keeping the id and reactivating", async () => {
      const s = await fresh();
      const a = account({ external_id: "did:plc:1", name: "Old", expires_at: T0 + 5, grant_id: "g1" });
      const id = await s.upsertAccount(a);
      const first = await s.getAccount("alice", id);
      expectNumeric(first);
      expect(first).toMatchObject({ ...a, id, status: "active", status_message: null });

      await s.setAccountStatus(id, "needs_reauth", "Token revoked");
      expect(await s.getAccount("alice", id)).toMatchObject({ status: "needs_reauth", status_message: "Token revoked" });

      const again = await s.upsertAccount({ ...a, name: "New", credentials: "encrypted-2", expires_at: null, meta: '{"x":1}' });
      expect(again).toBe(id);
      const updated = await s.getAccount("alice", id);
      expect(updated).toMatchObject({
        id,
        name: "New",
        credentials: "encrypted-2",
        expires_at: null,
        meta: '{"x":1}',
        status: "active",
        status_message: null,
        created_at: first!.created_at,
      });

      // Same external id for another owner or platform is another account.
      const bobs = await s.upsertAccount({ ...a, owner_id: "bob" });
      const onX = await s.upsertAccount({ ...a, platform: "x", connector: "x" });
      expect(new Set([id, bobs, onX]).size).toBe(3);
      expect(ids(await s.listAccounts("alice")).sort()).toEqual([id, onX].sort());
    });

    it("updates credentials and reactivates", async () => {
      const s = await fresh();
      const id = await s.upsertAccount(account({ expires_at: T0 }));
      await s.setAccountStatus(id, "needs_reauth", "Expired");
      await s.updateAccountCredentials(id, "refreshed", T0 + 3_600_000);
      const row = await s.getAccount(null, id);
      expectNumeric(row);
      expect(row).toMatchObject({ credentials: "refreshed", expires_at: T0 + 3_600_000, status: "active", status_message: null });
    });

    it("finds the accounts of one grant", async () => {
      const s = await fresh();
      const li = { platform: "linkedin", connector: "linkedin" } as const;
      const profile = await s.upsertAccount(account({ ...li, external_id: "person", grant_id: "g1" }));
      const page = await s.upsertAccount(account({ ...li, external_id: "org", grant_id: "g1" }));
      await s.upsertAccount(account({ ...li, external_id: "other", grant_id: "g2" }));
      await s.upsertAccount(account({ ...li, owner_id: "bob", external_id: "person", grant_id: "g1" }));
      await s.upsertAccount(account({ platform: "facebook", connector: "meta", external_id: "page", grant_id: "g1" }));

      const rows = await s.accountsByGrant("alice", "linkedin", "g1");
      expect(sorted(ids(rows))).toEqual(sorted([profile, page]));
      rows.forEach(expectNumeric);
      expect(await s.accountsByGrant("alice", "linkedin", "nope")).toEqual([]);
    });

    it("lists active accounts expiring before a time, for every owner", async () => {
      const s = await fresh();
      const soon = await s.upsertAccount(account({ expires_at: T0 + 10 }));
      const bobSoon = await s.upsertAccount(account({ owner_id: "bob", expires_at: T0 + 20 }));
      await s.upsertAccount(account({ expires_at: T0 + 1000 }));
      await s.upsertAccount(account({ expires_at: null }));
      const broken = await s.upsertAccount(account({ expires_at: T0 + 1 }));
      await s.setAccountStatus(broken, "needs_reauth", "Revoked");

      const rows = await s.accountsExpiringBefore(T0 + 100);
      expect(sorted(ids(rows))).toEqual(sorted([soon, bobSoon]));
      rows.forEach(expectNumeric);
      expect(ids(await s.accountsExpiringBefore(T0 + 20))).toEqual([soon]);
    });

    it("deletes an account", async () => {
      const s = await fresh();
      const id = await s.upsertAccount(account());
      expect(await s.deleteAccount("alice", id)).toBe(true);
      expect(await s.deleteAccount("alice", id)).toBe(false);
      expect(await s.getAccount(null, id)).toBeUndefined();
    });
  });

  it("scopes every owner-taking method to its owner", async () => {
    const s = await fresh();
    const accountId = await s.upsertAccount(account({ grant_id: "g1" }));
    const m = media();
    await s.insertMedia(m);
    const p = post({ media_ids: JSON.stringify([m.id]) });
    const failed = target(p, accountId, { status: "failed" });
    const queued = target(p, "acc-2");
    await s.insertPost(p, [failed, queued]);

    expect(await s.listAccounts("bob")).toEqual([]);
    expect(await s.getAccount("bob", accountId)).toBeUndefined();
    expect(await s.accountsByGrant("bob", "bluesky", "g1")).toEqual([]);
    expect(await s.getMedia("bob", m.id)).toBeUndefined();
    expect(await s.getPost("bob", p.id)).toBeUndefined();
    expect(await s.listPosts("bob", 10)).toEqual([]);
    expect(await s.getTarget("bob", failed.id)).toBeUndefined();
    expect(await s.retryTarget("bob", failed.id)).toBe(false);
    expect(await s.cancelTarget("bob", queued.id)).toBe(false);
    expect(await s.deletePost("bob", p.id)).toBe(false);
    expect(await s.deleteAccount("bob", accountId)).toBe(false);

    // Nothing changed for the owner; null means any owner.
    expect((await s.getTarget("alice", failed.id))?.status).toBe("failed");
    expect((await s.getTarget(null, queued.id))?.status).toBe("queued");
    expect(ids(await s.listAccounts("alice"))).toEqual([accountId]);
    expect((await s.getAccount(null, accountId))?.id).toBe(accountId);
    expect(await s.getMedia("alice", m.id)).toEqual(m);
    expect(await s.getMedia(null, m.id)).toEqual(m);
    expect(await s.getPost("alice", p.id)).toEqual(p);
    expect(await s.getPost(null, p.id)).toEqual(p);
    expect(ids(await s.listPosts("alice", 10))).toEqual([p.id]);
    expect(await s.accountsByGrant("alice", "bluesky", "g1")).toHaveLength(1);
  });

  describe("OAuth state", () => {
    const state = (over: { state: string; created_at: number }) => ({
      owner_id: "alice",
      connector: "x",
      code_verifier: "verifier",
      return_to: "https://app.example.com/settings",
      ...over,
    });

    it("is single use", async () => {
      const s = await fresh();
      const now = Date.now();
      await s.saveOAuthState(state({ state: "s1", created_at: now }));
      expect(await s.takeOAuthState("s1", now - 60_000)).toEqual(state({ state: "s1", created_at: now }));
      expect(await s.takeOAuthState("s1", now - 60_000)).toBeUndefined();
      expect(await s.takeOAuthState("unknown", 0)).toBeUndefined();

      // Two callbacks racing for one state: only one gets it.
      await s.saveOAuthState(state({ state: "s2", created_at: now }));
      const results = await Promise.all([s.takeOAuthState("s2", 0), s.takeOAuthState("s2", 0), s.takeOAuthState("s2", 0)]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it("expires", async () => {
      const s = await fresh();
      const now = Date.now();
      await s.saveOAuthState(state({ state: "old", created_at: now - 60_000 }));
      expect(await s.takeOAuthState("old", now - 30_000)).toBeUndefined();
      // An expired state is still used up.
      expect(await s.takeOAuthState("old", 0)).toBeUndefined();

      // States older than a day are cleaned up when new ones are saved.
      await s.saveOAuthState(state({ state: "ancient", created_at: now - 25 * 3600_000 }));
      await s.saveOAuthState(state({ state: "new", created_at: now }));
      expect(await s.takeOAuthState("ancient", 0)).toBeUndefined();
      expect(await s.takeOAuthState("new", 0)).toBeDefined();
    });
  });

  describe("media", () => {
    it("inserts, gets and deletes", async () => {
      const s = await fresh();
      const image = media();
      const video = media({ kind: "video", mime: "video/mp4", size: 5_000_000_000, width: 1080, height: 1920, duration: 12.5 });
      const bare = media({ width: null, height: null });
      for (const m of [image, video, bare]) await s.insertMedia(m);

      expect(await s.getMedia("alice", image.id)).toEqual(image);
      expect(await s.getMedia(null, video.id)).toEqual(video);
      expect(await s.getMedia(null, bare.id)).toEqual(bare);
      await s.deleteMedia(image.id);
      expect(await s.getMedia(null, image.id)).toBeUndefined();
      expect(await s.getMedia(null, video.id)).toEqual(video);
    });

    it("knows which media posts use, and which are orphans", async () => {
      const s = await fresh();
      const used = media({ created_at: T0 });
      const orphan = media({ created_at: T0 });
      const recent = media({ created_at: T0 + 10_000 });
      for (const m of [used, orphan, recent]) await s.insertMedia(m);
      const p = post({ media_ids: JSON.stringify([used.id]) });
      await s.insertPost(p, []);

      expect(await s.isMediaReferenced(used.id)).toBe(true);
      expect(await s.isMediaReferenced(orphan.id)).toBe(false);
      expect(await s.orphanMedia(T0 + 5000)).toEqual([orphan]);
      expect(sorted(ids(await s.orphanMedia(T0 + 20_000)))).toEqual(sorted([orphan.id, recent.id]));

      await s.deletePost("alice", p.id);
      expect(await s.isMediaReferenced(used.id)).toBe(false);
      expect(sorted(ids(await s.orphanMedia(T0 + 5000)))).toEqual(sorted([used.id, orphan.id]));
    });
  });

  describe("posts", () => {
    it("inserts a post with its media links and targets", async () => {
      const s = await fresh();
      const a = media();
      const b = media();
      await s.insertMedia(a);
      await s.insertMedia(b);
      const p = post({ title: "Title", media_ids: JSON.stringify([b.id, a.id]), scheduled_at: T0 + 60_000 });
      const t1 = target(p, "acc-1", { text_override: "Short", options: '{"privacy":"public"}', run_at: T0 + 60_000 });
      const t2 = target(p, "acc-2", { run_at: T0 + 60_000 });
      await s.insertPost(p, [t1, t2]);

      expect(await s.getPost("alice", p.id)).toEqual(p);
      expect(await s.isMediaReferenced(a.id)).toBe(true);
      expect(await s.isMediaReferenced(b.id)).toBe(true);
      expect(sorted(ids(await s.targetsForPosts([p.id])))).toEqual(sorted([t1.id, t2.id]));
      expect(await s.getTarget("alice", t1.id)).toEqual(t1);
    });

    it("inserts a post atomically: a failing target leaves nothing behind", async () => {
      const s = await fresh();
      const m = media();
      await s.insertMedia(m);
      const p = post({ media_ids: JSON.stringify([m.id]) });
      const t1 = target(p, "acc-1");
      const clash = { ...target(p, "acc-2"), id: t1.id };
      await expect(s.insertPost(p, [t1, clash])).rejects.toThrow();

      expect(await s.getPost(null, p.id)).toBeUndefined();
      expect(await s.listPosts("alice", 10)).toEqual([]);
      expect(await s.targetsForPosts([p.id])).toEqual([]);
      expect(await s.isMediaReferenced(m.id)).toBe(false);

      // The storage is still usable, and the same post can be saved.
      await s.insertPost(p, [t1]);
      expect(await s.getPost(null, p.id)).toEqual(p);
    });

    it("lists newest first, with a created_at cursor", async () => {
      const s = await fresh();
      const p1 = post({ id: "p-1", created_at: T0 + 1 });
      const p2 = post({ id: "p-2", created_at: T0 + 2 });
      const p3a = post({ id: "p-3a", created_at: T0 + 3 });
      const p3b = post({ id: "p-3b", created_at: T0 + 3 });
      const bobs = post({ id: "p-bob", owner_id: "bob", created_at: T0 + 4 });
      for (const p of [p2, p3a, bobs, p1, p3b]) await s.insertPost(p, []);

      const all = await s.listPosts("alice", 10);
      expect(ids(all)).toEqual(["p-3b", "p-3a", "p-2", "p-1"]);
      all.forEach(expectNumeric);
      expect(all[2]).toEqual(p2);
      expect(ids(await s.listPosts("alice", 2))).toEqual(["p-3b", "p-3a"]);
      expect(ids(await s.listPosts("alice", 10, T0 + 3))).toEqual(["p-2", "p-1"]);
      expect(ids(await s.listPosts("alice", 1, T0 + 3))).toEqual(["p-2"]);
      expect(await s.listPosts("alice", 10, T0 + 1)).toEqual([]);
      expect(ids(await s.listPosts("bob", 10))).toEqual(["p-bob"]);
    });

    it("deletes a post with its targets and media links", async () => {
      const s = await fresh();
      const m = media();
      await s.insertMedia(m);
      const p = post({ media_ids: JSON.stringify([m.id]) });
      const t1 = target(p, "acc-1");
      const t2 = target(p, "acc-2", { status: "succeeded" });
      await s.insertPost(p, [t1, t2]);
      const other = await enqueue(s, "acc-1");

      expect(await s.deletePost("alice", p.id)).toBe(true);
      expect(await s.getPost(null, p.id)).toBeUndefined();
      expect(await s.targetsForPosts([p.id])).toEqual([]);
      expect(await s.getTarget(null, t1.id)).toBeUndefined();
      expect(await s.isMediaReferenced(m.id)).toBe(false);
      expect(await s.getMedia(null, m.id)).toEqual(m);
      expect(await s.getTarget(null, other.id)).toEqual(other);
      expect(await s.deletePost("alice", p.id)).toBe(false);
    });

    it("lists the targets of several posts in a stable order", async () => {
      const s = await fresh();
      const p1 = post();
      const p2 = post();
      const p3 = post();
      const a = target(p1, "acc-1", { created_at: T0 + 1, platform: "bluesky", account_name: "B" });
      const b = target(p1, "acc-2", { created_at: T0, platform: "x", account_name: "A" });
      const c = target(p1, "acc-3", { created_at: T0 + 1, platform: "bluesky", account_name: "A" });
      const d = target(p2, "acc-1", { created_at: T0, platform: "bluesky", account_name: "A" });
      await s.insertPost(p1, [a, b, c]);
      await s.insertPost(p2, [d]);
      await s.insertPost(p3, [target(p3, "acc-1")]);

      const rows = await s.targetsForPosts([p1.id, p2.id]);
      expect(ids(rows)).toEqual([d.id, b.id, c.id, a.id]);
      expect(rows).toEqual([d, b, c, a]);
      expect(await s.targetsForPosts([])).toEqual([]);
      expect(await s.targetsForPosts(["missing"])).toEqual([]);
    });
  });

  describe("queue", () => {
    it("claims only due, queued targets and marks them running", async () => {
      const s = await fresh();
      const due = await enqueue(s, "acc-1", { run_at: T0 - 10, error: "Earlier attempt failed", attempts: 1, updated_at: T0 - 10 });
      await enqueue(s, "acc-2", { run_at: T0 + 60_000 });
      for (const [i, status] of (["failed", "succeeded", "cancelled"] as const).entries()) await enqueue(s, `acc-${3 + i}`, { status });

      const claimed = await s.claimDueTargets(10, T0, T0 + LEASE);
      expect(ids(claimed)).toEqual([due.id]);
      claimed.forEach(expectNumeric);
      expect(claimed[0]).toMatchObject({
        ...due,
        status: "running",
        attempts: 2,
        lease_until: T0 + LEASE,
        started_at: T0,
        progress: "Starting…",
        error: null,
        updated_at: T0,
      });
      // What a claim returns is what is stored.
      expect(claimed).toEqual(await stored(s, claimed));
      expect(await s.claimDueTargets(10, T0, T0 + LEASE)).toEqual([]);
    });

    it("claims at most one target per account, and none for an account with a running one", async () => {
      const s = await fresh();
      const a1 = await enqueue(s, "acc-a", { run_at: T0 - 300 });
      const a2 = await enqueue(s, "acc-a", { run_at: T0 - 200 });
      const b1 = await enqueue(s, "acc-b", { run_at: T0 - 100 });
      await enqueue(s, "acc-c", { status: "running", attempts: 1, lease_until: T0 + LEASE, started_at: T0 - 1000 });
      const c1 = await enqueue(s, "acc-c", { run_at: T0 - 400 });

      // Oldest first.
      expect(ids(await s.claimDueTargets(10, T0, T0 + LEASE))).toEqual([a1.id, b1.id]);
      expect(await s.claimDueTargets(10, T0, T0 + LEASE)).toEqual([]);

      await s.completeTarget(a1.id, "r1", null, null);
      expect(ids(await s.claimDueTargets(10, T0, T0 + LEASE))).toEqual([a2.id]);
      expect((await s.getTarget(null, c1.id))?.status).toBe("queued");
    });

    it("respects the limit", async () => {
      const s = await fresh();
      const targets: TargetRow[] = [];
      for (let i = 0; i < 5; i++) targets.push(await enqueue(s, `acc-${i}`, { run_at: T0 - i }));

      expect(ids(await s.claimDueTargets(2, T0, T0 + LEASE))).toEqual([targets[4].id, targets[3].id]);
      expect(ids(await s.claimDueTargets(1, T0, T0 + LEASE))).toEqual([targets[2].id]);
      expect(ids(await s.claimDueTargets(10, T0, T0 + LEASE))).toEqual([targets[1].id, targets[0].id]);
    });

    it("fills the limit from other accounts while one account has a long backlog", async () => {
      const s = await fresh();
      for (let i = 0; i < 12; i++) await enqueue(s, "busy", { run_at: T0 - 1000 + i });
      const quiet = await enqueue(s, "quiet", { run_at: T0 });

      const claimed = await s.claimDueTargets(2, T0, T0 + LEASE);
      expect(claimed.map((t) => t.account_id)).toEqual(["busy", "quiet"]);
      expect(claimed[1].id).toBe(quiet.id);
    });

    it("renews the leases of running targets only", async () => {
      const s = await fresh();
      const a = await enqueue(s, "acc-1");
      const b = await enqueue(s, "acc-2");
      await s.claimDueTargets(10, T0, T0 + 100);
      const waiting = await enqueue(s, "acc-3", { run_at: T0 + 60_000 });

      await s.renewLeases([a.id, waiting.id], T0 + 500);
      await s.renewLeases([], T0 + 900);
      const [ra, rb, rw] = await stored(s, [a, b, waiting]);
      expect(ra?.lease_until).toBe(T0 + 500);
      expect(rb?.lease_until).toBe(T0 + 100);
      expect(rw?.lease_until).toBeNull();
    });

    it("records progress", async () => {
      const s = await fresh();
      const t = await enqueue(s, "acc-1");
      await s.setTargetProgress(t.id, "Uploading 50%");
      expect((await s.getTarget(null, t.id))?.progress).toBe("Uploading 50%");
    });

    it("completes a target", async () => {
      const s = await fresh();
      const a = await enqueue(s, "acc-1");
      const b = await enqueue(s, "acc-2");
      await s.claimDueTargets(10, T0, T0 + LEASE);
      const before = Date.now();
      await s.completeTarget(a.id, "remote-1", "https://example.com/p/1", "Published as a draft");
      await s.completeTarget(b.id, "remote-2", null, null);

      const [ra, rb] = await stored(s, [a, b]);
      expectNumeric(ra);
      expect(ra).toMatchObject({
        status: "succeeded",
        remote_id: "remote-1",
        remote_url: "https://example.com/p/1",
        progress: "Published as a draft",
        error: null,
        lease_until: null,
        attempts: 1,
      });
      expect(ra!.finished_at).toBeGreaterThanOrEqual(before);
      expect(rb).toMatchObject({ status: "succeeded", remote_id: "remote-2", remote_url: null, progress: null });
      expect(await s.hasActiveTargetsForAccount("acc-1")).toBe(false);
    });

    it("fails a target for a retry later, or for good", async () => {
      const s = await fresh();
      const t = await enqueue(s, "acc-1");
      await s.claimDueTargets(10, T0, T0 + LEASE);
      await s.setTargetProgress(t.id, "Uploading");

      await s.failTarget(t.id, "Rate limited", T0 + 60_000);
      let row = await s.getTarget(null, t.id);
      expectNumeric(row);
      expect(row).toMatchObject({ status: "queued", run_at: T0 + 60_000, error: "Rate limited", progress: null, lease_until: null, attempts: 1 });
      expect(await s.claimDueTargets(10, T0 + 59_999, T0 + LEASE)).toEqual([]);

      const [again] = await s.claimDueTargets(10, T0 + 60_000, T0 + 60_000 + LEASE);
      expect(again).toMatchObject({ id: t.id, attempts: 2, error: null });

      const before = Date.now();
      await s.failTarget(t.id, "Rejected", null);
      row = await s.getTarget(null, t.id);
      expect(row).toMatchObject({ status: "failed", error: "Rejected", progress: null, lease_until: null, attempts: 2 });
      expect(row!.finished_at).toBeGreaterThanOrEqual(before);
      expect(await s.claimDueTargets(10, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toEqual([]);
    });

    it("retries only failed or cancelled targets, and cancels only queued ones", async () => {
      const s = await fresh();
      const statuses = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
      const rows = new Map<string, TargetRow>();
      for (const [i, status] of statuses.entries()) {
        rows.set(status, await enqueue(s, `acc-${i}`, { status, attempts: 2, error: status === "failed" ? "Boom" : null, finished_at: T0 }));
      }

      const before = Date.now();
      const retried = await Promise.all(statuses.map((st) => s.retryTarget("alice", rows.get(st)!.id)));
      expect(retried).toEqual([false, false, false, true, true]);
      for (const st of ["failed", "cancelled"]) {
        const row = await s.getTarget("alice", rows.get(st)!.id);
        expectNumeric(row);
        expect(row).toMatchObject({ status: "queued", attempts: 0, error: null, progress: null, finished_at: null });
        expect(row!.run_at).toBeGreaterThanOrEqual(before);
      }
      expect((await s.getTarget(null, rows.get("succeeded")!.id))?.status).toBe("succeeded");
      expect((await s.getTarget(null, rows.get("running")!.id))?.status).toBe("running");

      // Now queued: queued, failed, cancelled.
      const cancelled = await Promise.all(statuses.map((st) => s.cancelTarget("alice", rows.get(st)!.id)));
      expect(cancelled).toEqual([true, false, false, true, true]);
      const row = await s.getTarget(null, rows.get("queued")!.id);
      expect(row).toMatchObject({ status: "cancelled", progress: null });
      expect(row!.finished_at).toBeGreaterThanOrEqual(before);
      expect(await s.cancelTarget("alice", rows.get("queued")!.id)).toBe(false);
      expect((await s.getTarget(null, rows.get("running")!.id))?.status).toBe("running");
    });

    it("fails running targets whose lease expired, once", async () => {
      const s = await fresh();
      const running = { status: "running", attempts: 1, started_at: T0 - LEASE, updated_at: T0 - LEASE } as const;
      const expired = await enqueue(s, "acc-1", { ...running, lease_until: T0 - 1, progress: "Uploading" });
      const edge = await enqueue(s, "acc-2", { ...running, lease_until: T0 });
      const live = await enqueue(s, "acc-3", { ...running, lease_until: T0 + LEASE });
      const queued = await enqueue(s, "acc-1", { run_at: T0 - LEASE });

      const failed = await s.failExpiredLeases(T0, "Interrupted");
      expect(ids(failed)).toEqual([expired.id]);
      failed.forEach(expectNumeric);
      expect(failed[0]).toMatchObject({
        status: "failed",
        error: "Interrupted",
        progress: null,
        lease_until: null,
        finished_at: T0,
        updated_at: T0,
        attempts: 1,
      });
      expect(failed).toEqual(await stored(s, failed));
      expect(await s.failExpiredLeases(T0, "Interrupted")).toEqual([]);

      const [re, rl, rq] = await stored(s, [edge, live, queued]);
      expect(re?.status).toBe("running");
      expect(rl?.status).toBe("running");
      expect(rq?.status).toBe("queued");
      // Its account is free again.
      expect(ids(await s.claimDueTargets(10, T0, T0 + LEASE))).toEqual([queued.id]);
    });

    it("knows whether an account has queued or running targets", async () => {
      const s = await fresh();
      expect(await s.hasActiveTargetsForAccount("acc-1")).toBe(false);
      for (const status of ["succeeded", "failed", "cancelled"] as const) await enqueue(s, "acc-1", { status });
      expect(await s.hasActiveTargetsForAccount("acc-1")).toBe(false);

      const t = await enqueue(s, "acc-1");
      expect(await s.hasActiveTargetsForAccount("acc-1")).toBe(true);
      await s.claimDueTargets(10, T0, T0 + LEASE);
      expect((await s.getTarget(null, t.id))?.status).toBe("running");
      expect(await s.hasActiveTargetsForAccount("acc-1")).toBe(true);
      expect(await s.hasActiveTargetsForAccount("acc-2")).toBe(false);
    });
  });

  // Several storages over one database stand in for several processes.
  describe("shared database", () => {
    it("never claims a target twice or runs two targets of one account at once", async () => {
      const db = backend.database();
      const storages = [db.open(), db.open(), db.open()];
      await Promise.all(storages.map((s) => s.migrate()));
      const all: TargetRow[] = [];
      for (let a = 0; a < 6; a++) {
        for (let i = 0; i < 6; i++) all.push(await enqueue(storages[0], `acc-${a}`, { run_at: T0 - 100 + i }));
      }

      const claims = new Map<string, number>();
      const running = new Map<string, string>(); // account -> target
      const overlaps: string[] = [];
      const work = async (s: Storage) => {
        for (let idle = 0; idle < 20; ) {
          const jobs = await s.claimDueTargets(2, T0, T0 + LEASE);
          if (!jobs.length) {
            idle++;
            await new Promise((r) => setTimeout(r, 0));
            continue;
          }
          idle = 0;
          for (const job of jobs) {
            claims.set(job.id, (claims.get(job.id) ?? 0) + 1);
            if (running.has(job.account_id)) overlaps.push(job.account_id);
            running.set(job.account_id, job.id);
            expect(job.status).toBe("running");
            expect(job.attempts).toBe(1);
          }
          await new Promise((r) => setTimeout(r, 0));
          for (const job of jobs) {
            running.delete(job.account_id);
            await s.completeTarget(job.id, `remote-${job.id}`, null, null);
          }
        }
      };
      await Promise.all([...storages, ...storages].map(work));

      expect(overlaps).toEqual([]);
      expect(sorted([...claims.keys()])).toEqual(sorted(ids(all)));
      expect([...claims.values()].every((n) => n === 1)).toBe(true);
      const rows = await stored(storages[1], all);
      expect(rows.every((r) => r?.status === "succeeded" && r.attempts === 1)).toBe(true);
    });

    it("reports each expired job once when several storages look at the same time", async () => {
      const db = backend.database();
      const [a, b] = [db.open(), db.open()];
      await Promise.all([a.migrate(), b.migrate()]);
      const all: TargetRow[] = [];
      for (let i = 0; i < 10; i++) all.push(await enqueue(a, `acc-${i}`));
      expect(await a.claimDueTargets(10, T0, T0 + 10)).toHaveLength(10);

      const results = await Promise.all([a, b, a, b].map((s) => s.failExpiredLeases(T0 + 20, "Interrupted")));
      const reported = results.flatMap(ids);
      expect(sorted(reported)).toEqual(sorted(ids(all)));
      expect(new Set(reported).size).toBe(all.length);
    });

    it("takes an OAuth state once across storages", async () => {
      const db = backend.database();
      const [a, b] = [db.open(), db.open()];
      await Promise.all([a.migrate(), b.migrate()]);
      const now = Date.now();
      await a.saveOAuthState({ state: "s", owner_id: "alice", connector: "x", code_verifier: null, return_to: null, created_at: now });
      const results = await Promise.all([a.takeOAuthState("s", 0), b.takeOAuthState("s", 0)]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });
  });

  // ---- through the engine ------------------------------------------------------------------

  describe("engine", () => {
    const syncs: PostSync[] = [];
    afterEach(async () => {
      for (const s of syncs.splice(0)) await s.close();
    });

    async function engine(storage: Storage, mediaDir = tempDir()): Promise<PostSync> {
      const sync = await createPostSync({
        secret: TEST_SECRET,
        publicUrl: "https://app.example.com/social",
        storage,
        mediaDir,
        logger: false,
        worker: { autoStart: false, concurrency: 2 },
        sleep: async () => {},
      });
      syncs.push(sync);
      return sync;
    }

    it("connects, publishes and reads back with numbers intact", async () => {
      clearBlueskySessions();
      mockFetch(blueskyRoutes());
      const sync = await engine(backend.database().open());

      const [acc] = await sync.connect.withCredentials("alice", "bluesky", { identifier: "alice.bsky.social", appPassword: "p" });
      expect(typeof acc.createdAt).toBe("number");
      const m = await sync.media.fromBuffer("alice", PNG, "dot.png");
      expect(m.size).toBe(PNG.length);
      const created = await sync.posts.create("alice", { text: "Hello from storage tests", mediaIds: [m.id], targets: [{ accountId: acc.id }] });
      expect(created.targets[0].status).toBe("queued");

      expect(await sync.worker.runDue()).toEqual({ processed: 1 });
      const done = await sync.posts.get("alice", created.id);
      expect(done?.targets[0]).toMatchObject({ status: "succeeded", attempts: 1, remoteUrl: "https://bsky.app/profile/alice.bsky.social/post/3kp" });
      expect(typeof done?.createdAt).toBe("number");
      expect(typeof done?.targets[0].finishedAt).toBe("number");
      expect(typeof done?.targets[0].runAt).toBe("number");
      expect((await sync.posts.list("alice")).posts.map((p) => p.id)).toEqual([created.id]);
      expect(await sync.media.remove("alice", m.id)).toBe("in_use");
    });

    it("two engines on one database publish every target exactly once", async () => {
      clearBlueskySessions();
      const { calls } = mockFetch(blueskyRoutes());
      const db = backend.database();
      const mediaDir = tempDir();
      const one = await engine(db.open(), mediaDir);
      const two = await engine(db.open(), mediaDir);

      const accounts: PublicAccount[] = [];
      for (const name of ["a1", "a2", "a3"]) {
        accounts.push(...(await one.connect.withCredentials("alice", "bluesky", { identifier: `${name}.bsky.social`, appPassword: "p" })));
      }
      const m = await one.media.fromBuffer("alice", PNG, "dot.png");
      const posts: PublicPost[] = [];
      for (let i = 0; i < 4; i++) {
        posts.push(
          await (i % 2 ? two : one).posts.create("alice", {
            text: `Post ${i}`,
            mediaIds: i === 0 ? [m.id] : [],
            targets: accounts.map((a) => ({ accountId: a.id })),
          }),
        );
      }
      const succeeded: string[] = [];
      for (const s of [one, two]) s.on("target.succeeded", ({ target }) => succeeded.push(target.id));

      const [r1, r2] = await Promise.all([one.worker.runDue(), two.worker.runDue()]);
      expect(r1.processed + r2.processed).toBe(12);
      expect(r1.processed).toBeGreaterThan(0);
      expect(r2.processed).toBeGreaterThan(0);

      const records = calls.filter((c) => c.url.pathname.endsWith("/com.atproto.repo.createRecord"));
      expect(records).toHaveLength(12);
      const published = records.map((c) => {
        const body = JSON.parse(String(c.body));
        return `${body.repo} ${body.record.text}`;
      });
      expect(new Set(published).size).toBe(12);
      expect(new Set(succeeded).size).toBe(12);
      expect(succeeded).toHaveLength(12);
      for (const p of posts) {
        const done = await two.posts.get("alice", p.id);
        expect(done?.targets.map((t) => [t.status, t.attempts])).toEqual([
          ["succeeded", 1],
          ["succeeded", 1],
          ["succeeded", 1],
        ]);
      }
    });
  });
});

// ---- real processes ----------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SQLITE_MODULE = pathToFileURL(fileURLToPath(new URL("../src/storage/sqlite.ts", import.meta.url))).href;

// Opens the database, waits for "go" on stdin, then expires stale leases and works the queue until it is empty.
const CHILD = `
import { sqliteStorage } from ${JSON.stringify(SQLITE_MODULE)};
const [file, freshFile, t0, accountCount] = process.argv.slice(2);
const T0 = Number(t0);
const accounts = Array.from({ length: Number(accountCount) }, (_, i) => "acc-" + i);
const storage = sqliteStorage(file);
const fresh = sqliteStorage(freshFile);
process.stdout.write("ready\\n");
await new Promise((resolve) => process.stdin.once("data", resolve));
process.stdin.destroy();
await Promise.all([storage.migrate(), fresh.migrate()]);
const expired = (await storage.failExpiredLeases(T0, "Interrupted")).map((t) => t.id);
const claimed = [];
for (;;) {
  const jobs = await storage.claimDueTargets(2, T0, T0 + 60000);
  if (!jobs.length) {
    const active = await Promise.all(accounts.map((a) => storage.hasActiveTargetsForAccount(a)));
    if (!active.some(Boolean)) break;
    await new Promise((r) => setTimeout(r, 1));
    continue;
  }
  for (const job of jobs) claimed.push(job.id);
  await new Promise((r) => setTimeout(r, 1));
  for (const job of jobs) await storage.completeTarget(job.id, "remote-" + job.id, null, null);
}
await storage.close();
await fresh.close();
process.stdout.write(JSON.stringify({ expired, claimed }) + "\\n");
`;

interface ChildResult {
  expired: string[];
  claimed: string[];
}

function startChild(script: string, args: string[]) {
  const child = spawn(process.execPath, ["--import", "tsx", script, ...args], { cwd: REPO_ROOT, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let err = "";
  let onReady!: () => void;
  const readySignal = new Promise<void>((resolve) => (onReady = resolve));
  child.stdout.on("data", (d) => {
    out += d;
    if (out.startsWith("ready\n")) onReady();
  });
  child.stderr.on("data", (d) => (err += d));
  const result = new Promise<ChildResult>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 || !out.startsWith("ready\n")) return reject(new Error(`child exited with ${code}: ${err || out}`));
      resolve(JSON.parse(out.slice("ready\n".length)) as ChildResult);
    });
  });
  return {
    ready: Promise.race([readySignal, result.then(() => Promise.reject(new Error("child exited before it was ready")))]),
    result,
    go: () => child.stdin.end("go\n"),
    kill: () => child.kill(),
  };
}

describe("sqlite storage across processes", () => {
  it("several processes claim, complete and expire jobs without overlap, and migrate at once", async () => {
    const dir = tempDir();
    const file = path.join(dir, "shared.db");
    const freshFile = path.join(dir, "fresh.db");
    const accounts = 6;
    const seed = sqliteStorage(file);
    await seed.migrate();
    const queued: string[] = [];
    for (let a = 0; a < accounts; a++) {
      for (let i = 0; i < 15; i++) queued.push((await enqueue(seed, `acc-${a}`, { run_at: T0 - 100 + i })).id);
    }
    // Jobs of a process that died: their leases expired.
    const stale: string[] = [];
    for (let i = 0; i < 8; i++) {
      stale.push((await enqueue(seed, `stale-${i}`, { status: "running", attempts: 1, lease_until: T0 - 1, started_at: T0 - LEASE })).id);
    }
    await seed.close();

    const script = path.join(dir, "child.mjs");
    fs.writeFileSync(script, CHILD);
    const children = Array.from({ length: 4 }, () => startChild(script, [file, freshFile, String(T0), String(accounts)]));
    let results: ChildResult[];
    try {
      await Promise.all(children.map((c) => c.ready));
      for (const c of children) c.go();
      results = await Promise.all(children.map((c) => c.result));
    } finally {
      for (const c of children) c.kill();
    }

    const claimed = results.flatMap((r) => r.claimed);
    expect(sorted(claimed)).toEqual(sorted(queued));
    expect(new Set(claimed).size).toBe(claimed.length);
    expect(results.filter((r) => r.claimed.length > 0).length).toBeGreaterThan(1);
    const expired = results.flatMap((r) => r.expired);
    expect(sorted(expired)).toEqual(sorted(stale));

    const check = track(sqliteStorage(file));
    for (const id of queued) expect(await check.getTarget(null, id)).toMatchObject({ status: "succeeded", attempts: 1 });
    for (const id of stale) expect(await check.getTarget(null, id)).toMatchObject({ status: "failed", error: "Interrupted" });
    const migrated = track(sqliteStorage(freshFile));
    expect(await migrated.listAccounts("alice")).toEqual([]);
  }, 60_000);
});

// ---- the PGlite pool -----------------------------------------------------------------------------

describe("PGlite pool helper", () => {
  it("returns BIGINT as strings like pg, or as numbers on request", async () => {
    const sql = "SELECT 5000000000::bigint AS big, 3::int AS small, 1.5::float8 AS real";
    expect((await pool.query(sql)).rows).toEqual([{ big: "5000000000", small: 3, real: 1.5 }]);
    expect((await pglitePool(pglite, { int8: "number" }).query(sql)).rows).toEqual([{ big: 5000000000, small: 3, real: 1.5 }]);
  });

  it("reports row counts like pg", async () => {
    await pool.query("CREATE TABLE pool_counts (id INT PRIMARY KEY)");
    expect((await pool.query("INSERT INTO pool_counts VALUES (1), (2), (3)")).rowCount).toBe(3);
    expect((await pool.query("UPDATE pool_counts SET id = id + 10 WHERE id > $1", [1])).rowCount).toBe(2);
    expect((await pool.query("DELETE FROM pool_counts WHERE id = 99")).rowCount).toBe(0);
    expect((await pool.query("SELECT * FROM pool_counts")).rowCount).toBe(3);
  });

  it("gives a checked-out client the connection to itself until it is released", async () => {
    await pool.query("CREATE TABLE pool_lock (id INT)");
    const client = await pool.connect();
    await client.query("BEGIN");
    await client.query("INSERT INTO pool_lock VALUES (1)");
    let seen: number | undefined;
    const outside = pglitePool(pglite)
      .query("SELECT count(*)::int AS n FROM pool_lock")
      .then((r) => (seen = r.rows[0].n));
    await new Promise((r) => setTimeout(r, 20));
    // Not run inside the open transaction.
    expect(seen).toBeUndefined();
    await client.query("ROLLBACK");
    client.release();
    await outside;
    expect(seen).toBe(0);
    expect(() => client.release()).toThrow();
    await expect(client.query("SELECT 1")).rejects.toThrow();

    // Released with an error: whatever it left open is rolled back.
    const broken = await pool.connect();
    await broken.query("BEGIN");
    await broken.query("INSERT INTO pool_lock VALUES (2)");
    broken.release(true);
    expect((await pool.query("SELECT count(*)::int AS n FROM pool_lock")).rows[0].n).toBe(0);
  });
});

// ---- Bluesky mocks -------------------------------------------------------------------------------

const PDS = "https://pds.example.net";

function blueskyRoutes() {
  return [
    {
      method: "POST",
      match: "https://bsky.social/xrpc/com.atproto.server.createSession",
      reply: (call: MockCall) => {
        const handle = JSON.parse(String(call.body)).identifier as string;
        return {
          json: {
            did: `did:plc:${handle.split(".")[0]}`,
            handle,
            accessJwt: "JWT",
            didDoc: { service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: PDS }] },
          },
        };
      },
    },
    { method: "GET", match: `${PDS}/xrpc/app.bsky.actor.getProfile`, reply: () => ({ json: { displayName: "Someone" } }) },
    {
      method: "POST",
      match: `${PDS}/xrpc/com.atproto.repo.uploadBlob`,
      reply: () => ({ json: { blob: { $type: "blob", ref: { $link: "b" }, mimeType: "image/png", size: 10 } } }),
    },
    {
      method: "POST",
      match: `${PDS}/xrpc/com.atproto.repo.createRecord`,
      reply: () => ({ json: { uri: "at://did:plc:x/app.bsky.feed.post/3kp", cid: "c" } }),
    },
  ];
}

// 1x1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
