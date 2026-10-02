import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHandler, createPostSync, type PostSync } from "../src/index.js";
import { clearBlueskySessions } from "../src/platforms/bluesky.js";
import { sqliteStorage } from "../src/storage/sqlite.js";
import type { PostSyncEventName } from "../src/types.js";
import { mockFetch, tempDir, TEST_SECRET } from "./helpers.js";

const PDS = "https://pds.example.net";
const session = (did: string, handle: string) => ({
  did,
  handle,
  accessJwt: "JWT",
  didDoc: { service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: PDS }] },
});

function blueskyRoutes() {
  return [
    {
      method: "POST",
      match: "https://bsky.social/xrpc/com.atproto.server.createSession",
      reply: (call: any) => {
        const id = JSON.parse(String(call.body)).identifier as string;
        return { json: session(`did:plc:${id.split(".")[0]}`, id) };
      },
    },
    { method: "GET", match: `${PDS}/xrpc/app.bsky.actor.getProfile`, reply: () => ({ json: { displayName: "Someone" } }) },
    { method: "POST", match: `${PDS}/xrpc/com.atproto.repo.uploadBlob`, reply: () => ({ json: { blob: { $type: "blob", ref: { $link: "b" }, mimeType: "image/png", size: 10 } } }) },
    { method: "POST", match: `${PDS}/xrpc/com.atproto.repo.createRecord`, reply: () => ({ json: { uri: "at://did:plc:x/app.bsky.feed.post/3kp", cid: "c" } }) },
  ];
}

// 1x1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

describe("engine", () => {
  let sync: PostSync;
  beforeEach(async () => {
    clearBlueskySessions();
    sync = await createPostSync({
      secret: TEST_SECRET,
      publicUrl: "https://app.example.com/social",
      storage: sqliteStorage(":memory:"),
      mediaDir: tempDir(),
      logger: false,
      worker: { autoStart: false },
      sleep: async () => {},
    });
  });
  afterEach(async () => sync.close());

  it("connects, uploads, publishes and keeps owners apart", async () => {
    mockFetch(blueskyRoutes());
    const events: PostSyncEventName[] = [];
    sync.events.onAny((name) => events.push(name));

    const [alice] = await sync.connect.withCredentials("alice", "bluesky", { identifier: "alice.bsky.social", appPassword: "p" });
    const [bob] = await sync.connect.withCredentials("bob", "bluesky", { identifier: "bob.bsky.social", appPassword: "p" });
    expect(alice.ownerId).toBe("alice");
    expect((await sync.accounts.list("alice")).map((a) => a.id)).toEqual([alice.id]);
    expect(await sync.accounts.get("bob", alice.id)).toBeNull();

    const media = await sync.media.fromBuffer("alice", PNG, "dot.png");
    expect(media.url).toMatch(/^https:\/\/app\.example\.com\/social\/media\//);

    // Bob can't use Alice's account or media.
    await expect(sync.posts.create("bob", { text: "hi", targets: [{ accountId: alice.id }] })).rejects.toThrow();
    await expect(sync.posts.create("bob", { text: "hi", mediaIds: [media.id], targets: [{ accountId: bob.id }] })).rejects.toThrow();

    const post = await sync.posts.create("alice", { text: "Hello #world", mediaIds: [media.id], platforms: ["bluesky"] });
    expect(post.targets).toHaveLength(1);
    expect(post.targets[0].status).toBe("queued");

    const { processed } = await sync.worker.runDue();
    expect(processed).toBe(1);
    const done = await sync.posts.get("alice", post.id);
    expect(done?.targets[0].status).toBe("succeeded");
    expect(done?.targets[0].remoteUrl).toBe("https://bsky.app/profile/alice.bsky.social/post/3kp");
    expect(await sync.posts.get("bob", post.id)).toBeNull();
    expect((await sync.posts.list("bob")).posts).toEqual([]);
    expect(events).toEqual(expect.arrayContaining(["account.connected", "post.created", "target.started", "target.succeeded"]));
  });

  it("serves the HTTP API per owner", async () => {
    mockFetch(blueskyRoutes());
    const handler = createHandler(sync, { authenticate: (req) => req.headers.get("x-user") });
    const call = (method: string, path: string, user: string | null, body?: unknown) =>
      handler.fetch(
        new Request(`https://app.example.com/social${path}`, {
          method,
          headers: { ...(user ? { "x-user": user } : {}), ...(body ? { "content-type": "application/json" } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        }),
      );

    expect((await call("GET", "/accounts", null)).status).toBe(401);
    const connected = await call("POST", "/connect/bluesky/credentials", "alice", { fields: { identifier: "alice.bsky.social", appPassword: "p" } });
    expect(connected.status).toBe(201);
    const { accounts } = (await connected.json()) as any;

    const form = new FormData();
    form.append("file", new Blob([PNG], { type: "image/png" }), "dot.png");
    const up = await handler.fetch(new Request("https://app.example.com/social/media", { method: "POST", headers: { "x-user": "alice" }, body: form }));
    expect(up.status).toBe(201);
    const { media } = (await up.json()) as any;
    expect(media[0].kind).toBe("image");

    // The signed media URL is public (platforms download from it).
    const file = await handler.fetch(new Request(media[0].url));
    expect(file.status).toBe(200);
    expect(Buffer.from(await file.arrayBuffer()).equals(PNG)).toBe(true);

    const created = await call("POST", "/posts", "alice", { text: "From HTTP", mediaIds: [media[0].id], targets: [{ accountId: accounts[0].id }] });
    expect(created.status).toBe(201);
    const { post } = (await created.json()) as any;
    expect((await call("GET", `/posts/${post.id}`, "bob")).status).toBe(404);
    expect((await call("GET", `/posts/${post.id}`, "alice")).status).toBe(200);

    // Cross-site browser writes are refused.
    const csrf = await handler.fetch(
      new Request("https://app.example.com/social/posts", {
        method: "POST",
        headers: { "x-user": "alice", origin: "https://evil.example", "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(csrf.status).toBe(403);

    // Paths outside the handler fall through.
    const other = await handler.fetch(new Request("https://app.example.com/elsewhere"));
    expect(other.headers.get("x-post-sync-unmatched")).toBe("1");
  });
});
