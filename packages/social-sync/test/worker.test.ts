/**
 * The worker and account service under failure: database errors around publishing, shutdown, concurrency, leases
 * and rejected logins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountService } from "../src/accounts.js";
import { Secrets } from "../src/crypto.js";
import { PostSyncEmitter } from "../src/events.js";
import { createPostSync, type PostSync, type PostSyncEventName, type PostSyncEvents } from "../src/index.js";
import { clearBlueskySessions } from "../src/platforms/bluesky.js";
import { sqliteStorage } from "../src/storage/sqlite.js";
import type { NewAccount, Storage } from "../src/storage/types.js";
import { mockFetch, tempDir, testConfig, TEST_SECRET, type MockCall, type Route } from "./helpers.js";

const PDS = "https://morel.us-east.host.bsky.network";
const XAPI = "https://api.x.com/2";
const POST_URL = "https://bsky.app/profile/alice.bsky.social/post/3kp";
const LEASE = 2 * 60_000;

// ---- helpers ------------------------------------------------------------------------------------

type Faults = { -readonly [K in keyof Storage]?: Storage[K] };

/** A storage whose methods a test can replace, to make the database fail at chosen moments. */
function faulty(base: Storage): { storage: Storage; faults: Faults } {
  const faults: Faults = {};
  const storage = new Proxy(base, {
    get(target, prop) {
      const override = faults[prop as keyof Storage];
      if (override) return override;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { storage, faults };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const dbDown = () => Promise.reject(new Error("connection terminated unexpectedly"));

const realNow = Date.now;
let clockOffset = 0;
/** Moves Date.now forward, as if that much time had passed (undone after each test). */
function advanceClock(ms: number): void {
  clockOffset += ms;
  vi.spyOn(Date, "now").mockImplementation(() => realNow.call(Date) + clockOffset);
}

function blueskyRoutes(createRecord: Route["reply"] = () => ({ json: { uri: "at://did:plc:x/app.bsky.feed.post/3kp", cid: "c" } })): Route[] {
  return [
    {
      method: "POST",
      match: "https://bsky.social/xrpc/com.atproto.server.createSession",
      reply: (call) => {
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
    { method: "POST", match: `${PDS}/xrpc/com.atproto.repo.createRecord`, reply: createRecord },
  ];
}

const records = (calls: MockCall[]) => calls.filter((c) => c.url.pathname.endsWith("/com.atproto.repo.createRecord"));

const engines: PostSync[] = [];
const allFaults: Faults[] = [];
let logs: string[];

async function engine(opts: { concurrency?: number; base?: Storage; throwingLogger?: boolean } = {}) {
  const { storage, faults } = faulty(opts.base ?? sqliteStorage(":memory:"));
  allFaults.push(faults);
  const log = (message: string) => {
    logs.push(message);
    if (opts.throwingLogger) throw new Error("logger bug");
  };
  const sync = await createPostSync({
    secret: TEST_SECRET,
    publicUrl: "https://app.example.com/social",
    storage,
    mediaDir: tempDir(),
    platforms: { x: { clientId: "x-id", clientSecret: "x-secret" }, meta: { appId: "meta-app", appSecret: "meta-secret" } },
    logger: { info: () => {}, warn: log, error: log },
    worker: { autoStart: false, concurrency: opts.concurrency ?? 2, pollIntervalMs: 60_000 },
    sleep: async () => {},
  });
  engines.push(sync);
  return { sync, faults, db: storage };
}

function collect<E extends PostSyncEventName>(sync: PostSync, event: E): PostSyncEvents[E][] {
  const seen: PostSyncEvents[E][] = [];
  sync.on(event, (payload) => seen.push(payload));
  return seen;
}

async function blueskyAccount(sync: PostSync, handle = "alice.bsky.social"): Promise<string> {
  const [account] = await sync.connect.withCredentials("alice", "bluesky", { identifier: handle, appPassword: "p" });
  return account.id;
}

async function targetOf(sync: PostSync, postId: string) {
  return (await sync.posts.get("alice", postId))!.targets[0];
}

function xAccount(over: Partial<NewAccount> = {}): NewAccount {
  return {
    owner_id: "alice",
    platform: "x",
    connector: "x",
    external_id: "x-1",
    name: "Alice",
    username: "alice",
    avatar_url: null,
    credentials: new Secrets(TEST_SECRET).encrypt({ accessToken: "A1", refreshToken: "R1" }),
    meta: "{}",
    grant_id: null,
    expires_at: Date.now() - 1000,
    ...over,
  };
}

const xTokenRejected = { status: 400, json: { error: "invalid_request", error_description: "Value passed for the token was invalid." } };

let rejections: unknown[];
const onRejection = (reason: unknown) => rejections.push(reason);

beforeEach(() => {
  logs = [];
  rejections = [];
  clearBlueskySessions();
  process.on("unhandledRejection", onRejection);
});

afterEach(async () => {
  for (const f of allFaults.splice(0)) for (const key of Object.keys(f)) delete f[key as keyof Faults];
  clockOffset = 0;
  vi.restoreAllMocks();
  for (const sync of engines.splice(0)) await sync.close();
  process.off("unhandledRejection", onRejection);
});

/** Lets pending promise callbacks (and an unhandled rejection report) run. */
const settle = () => delay(20);

/** Waits until `check` passes (or gives up after `timeoutMs`, leaving the assertions to fail). */
async function until(check: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  for (const end = Date.now() + timeoutMs; Date.now() < end && !(await check()); ) await delay(5);
}

// ---- database errors around publishing -----------------------------------------------------------

describe("database errors while recording a job's outcome", () => {
  it("never become an unhandled rejection on the failure path", async () => {
    const { sync, faults } = await engine();
    const { calls } = mockFetch(blueskyRoutes(() => ({ status: 400, json: { error: "InvalidRequest", message: "bad record" } })));
    const accountId = await blueskyAccount(sync);
    const post = await sync.posts.create("alice", { text: "hi", targets: [{ accountId }] });
    const failed = collect(sync, "target.failed");
    faults.failTarget = dbDown;
    faults.getTarget = dbDown;

    // The started worker: nothing awaits its jobs, so a rejected job would be an unhandled rejection (a crash).
    sync.worker.start();
    await until(() => records(calls).length === 1 && logs.some((m) => m.startsWith("couldn't record")));
    await settle();
    expect(rejections).toEqual([]);
    expect(logs).toContainEqual(expect.stringMatching(/couldn't record that publishing to bluesky\/.* failed \(.*bad record.*\): connection terminated/));
    // Not recorded: it stays running, and is reported when its lease runs out.
    expect(failed).toEqual([]);
    await sync.worker.stop();
    delete faults.failTarget;
    delete faults.getTarget;
    expect((await targetOf(sync, post.id)).status).toBe("running");

    advanceClock(LEASE + 60_000);
    await sync.worker.runDue();
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ willRetry: false, error: expect.stringMatching(/may already be live/) });
    expect(records(calls)).toHaveLength(1);
  });

  it("never become an unhandled rejection even when the logger throws", async () => {
    const { sync } = await engine({ throwingLogger: true });
    mockFetch(blueskyRoutes(() => ({ status: 400, json: { error: "InvalidRequest", message: "bad record" } })));
    const accountId = await blueskyAccount(sync);
    const post = await sync.posts.create("alice", { text: "hi", targets: [{ accountId }] });
    sync.worker.start();
    await until(async () => (await targetOf(sync, post.id)).status === "failed");
    await settle();
    expect(rejections).toEqual([]);
    expect((await targetOf(sync, post.id)).status).toBe("failed");
    expect(logs).toContainEqual(expect.stringMatching(/^publish job .* failed unexpectedly: logger bug/));
  });

  it("keeps a published post succeeded while the database recovers", async () => {
    const { sync, faults, db } = await engine();
    const { calls } = mockFetch(blueskyRoutes());
    const accountId = await blueskyAccount(sync);
    const post = await sync.posts.create("alice", { text: "hi", targets: [{ accountId }] });
    const failed = collect(sync, "target.failed");
    const succeeded = collect(sync, "target.succeeded");
    let attempts = 0;
    const complete = db.completeTarget.bind(db);
    faults.completeTarget = (...args) => (++attempts <= 3 ? dbDown() : complete(...args));

    await sync.worker.runDue();
    expect(attempts).toBe(4);
    const target = await targetOf(sync, post.id);
    expect(target).toMatchObject({ status: "succeeded", remoteUrl: POST_URL });
    expect(failed).toEqual([]);
    expect(succeeded.map((e) => e.target.status)).toEqual(["succeeded"]);
    expect(records(calls)).toHaveLength(1);
    expect(await sync.targets.retry("alice", target.id)).toBe(false);
  });

  it("leaves a published job running when it can't be recorded at all, instead of marking it failed", async () => {
    const { sync, faults } = await engine();
    const { calls } = mockFetch(blueskyRoutes());
    const accountId = await blueskyAccount(sync);
    const post = await sync.posts.create("alice", { text: "hi", targets: [{ accountId }] });
    const failed = collect(sync, "target.failed");
    const succeeded = collect(sync, "target.succeeded");
    faults.completeTarget = dbDown;

    await sync.worker.runDue();
    await settle();
    expect(rejections).toEqual([]);
    expect(failed).toEqual([]);
    expect(succeeded).toEqual([]);
    expect(logs).toContainEqual(expect.stringMatching(/couldn't record that bluesky\/.+ published https:\/\/bsky\.app\/.*connection terminated/));
    delete faults.completeTarget;
    const target = await targetOf(sync, post.id);
    expect(target.status).toBe("running");

    // Once its lease runs out, it is reported as possibly live and never re-posted automatically.
    advanceClock(LEASE + 60_000);
    await sync.worker.runDue();
    expect(failed).toHaveLength(1);
    expect((await targetOf(sync, post.id)).error).toMatch(/may already be live/);
    expect(records(calls)).toHaveLength(1);
  });

  it("reports success from what it knows when reading the job back fails", async () => {
    const { sync, faults } = await engine();
    mockFetch(blueskyRoutes());
    const accountId = await blueskyAccount(sync);
    const post = await sync.posts.create("alice", { text: "hi", targets: [{ accountId }] });
    const failed = collect(sync, "target.failed");
    const succeeded = collect(sync, "target.succeeded");
    faults.getTarget = dbDown;

    await sync.worker.runDue();
    delete faults.getTarget;
    // It used to be overwritten with "failed" here, inviting a duplicate retry.
    expect((await targetOf(sync, post.id)).status).toBe("succeeded");
    expect(failed).toEqual([]);
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0].target).toMatchObject({ postId: post.id, status: "succeeded", remoteUrl: POST_URL, error: null });
  });
});

// ---- shutdown -----------------------------------------------------------------------------------------

describe("stop()", () => {
  it("waits for a claim in progress and the job it starts", async () => {
    const { sync, faults, db } = await engine();
    const { calls } = mockFetch(blueskyRoutes());
    const accountId = await blueskyAccount(sync);
    const post = await sync.posts.create("alice", { text: "hi", targets: [{ accountId }] });
    const claiming = deferred();
    const gate = deferred();
    const claim = db.claimDueTargets.bind(db);
    faults.claimDueTargets = async (...args) => {
      claiming.resolve();
      await gate.promise;
      return claim(...args);
    };

    sync.worker.start();
    await claiming.promise;
    let stopped = false;
    const stopping = sync.worker.stop(10_000).then(() => (stopped = true));
    await delay(30);
    expect(stopped).toBe(false);

    gate.resolve();
    await stopping;
    // The job it claimed ran to the end before stop() returned.
    expect((await targetOf(sync, post.id)).status).toBe("succeeded");
    expect(records(calls)).toHaveLength(1);
    expect(sync.worker.isRunning()).toBe(false);
  });

  it("doesn't leave a timer behind when nothing runs", async () => {
    const { sync } = await engine();
    sync.worker.start();
    await sync.worker.idle();
    const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    const before = timers();
    const started = Date.now();
    await sync.worker.stop(60_000);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(timers()).toBeLessThanOrEqual(before);
  });
});

// ---- concurrency ----------------------------------------------------------------------------------------

describe("concurrency", () => {
  it("never runs more jobs than the concurrency, even with overlapping runDue() calls", async () => {
    const { sync, faults, db } = await engine({ concurrency: 2 });
    let inFlight = 0;
    let maxInFlight = 0;
    mockFetch(
      blueskyRoutes(async () => {
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        await delay(15);
        inFlight--;
        return { json: { uri: "at://did:plc:x/app.bsky.feed.post/3kp", cid: "c" } };
      }),
    );
    const posts: string[] = [];
    for (let i = 0; i < 5; i++) {
      const accountId = await blueskyAccount(sync, `user${i}.bsky.social`);
      posts.push((await sync.posts.create("alice", { text: `Post ${i}`, targets: [{ accountId }] })).id);
    }
    const limits: number[] = [];
    const claim = db.claimDueTargets.bind(db);
    faults.claimDueTargets = async (limit, ...rest) => {
      limits.push(limit);
      await delay(10);
      return claim(limit, ...rest);
    };

    const results = await Promise.all([sync.worker.runDue(), sync.worker.runDue(), sync.worker.runDue()]);
    expect(results.reduce((n, r) => n + r.processed, 0)).toBe(5);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(limits.every((l) => l <= 2)).toBe(true);
    for (const id of posts) expect((await targetOf(sync, id)).status).toBe("succeeded");
  });
});

// ---- leases ---------------------------------------------------------------------------------------------------

describe("leases", () => {
  it("renews its own leases before failing expired ones, so it never fails a job it is still running", async () => {
    const { sync, faults, db } = await engine();
    const publishing = deferred();
    const gate = deferred();
    mockFetch(
      blueskyRoutes(async () => {
        publishing.resolve();
        await gate.promise;
        return { json: { uri: "at://did:plc:x/app.bsky.feed.post/3kp", cid: "c" } };
      }),
    );
    const accountId = await blueskyAccount(sync);
    const post = await sync.posts.create("alice", { text: "hi", targets: [{ accountId }] });
    const failed = collect(sync, "target.failed");

    const first = sync.worker.runDue();
    await publishing.promise;
    // Heartbeats were missed (a blocked event loop, a slow database): the stored lease ran out.
    advanceClock(LEASE + 60_000);
    const recovered = deferred();
    const failExpired = db.failExpiredLeases.bind(db);
    faults.failExpiredLeases = async (...args) => {
      const rows = await failExpired(...args);
      recovered.resolve();
      return rows;
    };
    const second = sync.worker.runDue();
    await recovered.promise;
    const [row] = (await sync.posts.get("alice", post.id))!.targets;
    expect(row.status).toBe("running");

    gate.resolve();
    await Promise.all([first, second]);
    expect(failed).toEqual([]);
    expect((await targetOf(sync, post.id)).status).toBe("succeeded");
  });
});

// ---- rejected logins ----------------------------------------------------------------------------------------

describe("rejected logins", () => {
  it("flag the account once and refresh once when the platform rejects the refresh", async () => {
    const { sync } = await engine();
    const { calls } = mockFetch([
      { method: "POST", match: `${XAPI}/oauth2/token`, reply: () => xTokenRejected },
      { method: "POST", match: `${XAPI}/tweets`, reply: () => ({ json: { data: { id: "1" } } }) },
    ]);
    const accountId = await sync.db.upsertAccount(xAccount());
    const post = await sync.posts.create("alice", { text: "hi", targets: [{ accountId }] });
    const flagged = collect(sync, "account.needsReconnect");

    await sync.worker.runDue();
    expect((await targetOf(sync, post.id)).status).toBe("failed");
    expect(flagged).toHaveLength(1);
    expect(flagged[0].account).toMatchObject({ id: accountId, status: "needs_reauth" });
    expect(calls.filter((c) => c.url.pathname.endsWith("/oauth2/token"))).toHaveLength(1);
    expect(calls.filter((c) => c.url.pathname.endsWith("/tweets"))).toHaveLength(0);

    // Checking it again reports the problem without flagging it a second time.
    expect(await sync.accounts.check("alice", accountId)).toMatchObject({ ok: false, needsReconnect: true });
    expect(flagged).toHaveLength(1);
  });

  it("flag the account once when a 401 forces a refresh that is rejected", async () => {
    const { sync } = await engine();
    const { calls } = mockFetch([
      { method: "POST", match: `${XAPI}/oauth2/token`, reply: () => xTokenRejected },
      { method: "POST", match: `${XAPI}/tweets`, reply: () => ({ status: 401, json: { title: "Unauthorized", detail: "Unauthorized" } }) },
    ]);
    const accountId = await sync.db.upsertAccount(xAccount({ expires_at: Date.now() + 3600_000 }));
    const post = await sync.posts.create("alice", { text: "hi", targets: [{ accountId }] });
    const flagged = collect(sync, "account.needsReconnect");

    await sync.worker.runDue();
    expect((await targetOf(sync, post.id)).status).toBe("failed");
    expect(flagged).toHaveLength(1);
    expect(calls.filter((c) => c.url.pathname.endsWith("/oauth2/token"))).toHaveLength(1);
    expect(calls.filter((c) => c.url.pathname.endsWith("/tweets"))).toHaveLength(1);
  });

  it("are reported once however often the account is flagged", async () => {
    const { sync } = await engine();
    const accountId = await sync.db.upsertAccount(xAccount({ expires_at: Date.now() + 3600_000 }));
    const flagged = collect(sync, "account.needsReconnect");
    const row = (await sync.db.getAccount(null, accountId))!;
    await Promise.all([sync.accountService.markNeedsReconnect(row, "Revoked"), sync.accountService.markNeedsReconnect(row, "Revoked")]);
    await sync.accountService.markNeedsReconnect(row, "Revoked again");
    expect(flagged).toHaveLength(1);
  });
});

// ---- token refresh races -------------------------------------------------------------------------------------

describe("token refresh", () => {
  const tokenOk = (access: string, refresh: string) => ({ json: { access_token: access, refresh_token: refresh, expires_in: 7200 } });

  function services(db: Storage) {
    const make = () => {
      const events = new PostSyncEmitter(() => {});
      const flagged: unknown[] = [];
      events.on("account.needsReconnect", (e) => flagged.push(e));
      return { service: new AccountService(db, new Secrets(TEST_SECRET), testConfig(), events), flagged };
    };
    return [make(), make()];
  }

  it("refreshes once in a process when several callers need a token at the same time", async () => {
    const db = sqliteStorage(":memory:");
    await db.migrate();
    const id = await db.upsertAccount(xAccount());
    const { calls } = mockFetch([{ method: "POST", match: `${XAPI}/oauth2/token`, reply: () => tokenOk("A2", "R2") }]);
    const [{ service }] = services(db);

    const results = await Promise.all([service.credentials(id, { force: true }), service.credentials(id, { force: true }), service.credentials(id)]);
    expect(results.map((c) => c.accessToken)).toEqual(["A2", "A2", "A2"]);
    expect(calls).toHaveLength(1);
    await db.close();
  });

  it("uses the token another process refreshed instead of flagging the account (X refresh tokens are single use)", async () => {
    const db = sqliteStorage(":memory:");
    await db.migrate();
    const id = await db.upsertAccount(xAccount());
    const { calls } = mockFetch([
      {
        method: "POST",
        match: `${XAPI}/oauth2/token`,
        // The first refresh wins; the second one used the same (now spent) refresh token.
        reply: async (_call, n) => (n === 1 ? tokenOk("A2", "R2") : (await delay(30), xTokenRejected)),
      },
    ]);
    const [one, two] = services(db);

    const [a, b] = await Promise.all([one.service.credentials(id), two.service.credentials(id)]);
    expect(calls).toHaveLength(2);
    expect(a).toEqual({ accessToken: "A2", refreshToken: "R2" });
    expect(b).toEqual({ accessToken: "A2", refreshToken: "R2" });
    expect([...one.flagged, ...two.flagged]).toEqual([]);
    expect((await db.getAccount(null, id))?.status).toBe("active");
    await db.close();
  });
});

// ---- maintenance ------------------------------------------------------------------------------------------------

describe("maintain()", () => {
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

  it("flags expired logins and deletes old orphan uploads once, which runDue() doesn't do", async () => {
    const { sync } = await engine();
    const media = await sync.media.fromBuffer("alice", PNG, "dot.png");
    const accountId = await sync.db.upsertAccount(
      xAccount({ platform: "facebook", connector: "meta", external_id: "page-1", expires_at: Date.now() + 3600_000 }),
    );
    const flagged = collect(sync, "account.needsReconnect");

    advanceClock(25 * 3600_000);
    expect(await sync.worker.runDue()).toEqual({ processed: 0 });
    expect(await sync.media.get("alice", media.id)).not.toBeNull();
    expect(flagged).toEqual([]);

    expect(await sync.worker.maintain()).toEqual({ cleanedMedia: 1 });
    expect(await sync.media.get("alice", media.id)).toBeNull();
    expect(flagged).toHaveLength(1);
    expect((await sync.accounts.get("alice", accountId))?.status).toBe("needs_reauth");

    expect(await sync.worker.maintain()).toEqual({ cleanedMedia: 0 });
    expect(flagged).toHaveLength(1);
  });
});
