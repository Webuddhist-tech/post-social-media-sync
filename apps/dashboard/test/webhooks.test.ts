import crypto from "node:crypto";
import { createPostSync, type PostSync, type PublicPost, type PublicTarget } from "post-social-media-sync";
import { sqliteStorage } from "post-social-media-sync/sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forwardEvents, signWebhook, type WebhookOptions } from "../src/webhooks.js";
import { mockFetch, removeTempDirs, tempDir, TEST_SECRET, type MockCall } from "./helpers.js";

const HOOK = "https://hooks.example.com/post-sync";
const post = { id: "p1", ownerId: "u1", text: "hi" } as PublicPost;
const target = { id: "t1", postId: "p1", ownerId: "u1", status: "running" } as PublicTarget;

describe("webhooks", () => {
  let sync: PostSync;
  let stop: (() => void) | null;
  const warn = vi.fn((_msg: string) => {});
  const sleep = vi.fn(async (_ms: number) => {});

  beforeEach(async () => {
    sync = await createPostSync({
      secret: TEST_SECRET,
      publicUrl: "https://posts.example.com/api",
      storage: sqliteStorage(":memory:"),
      mediaDir: tempDir(),
      logger: false,
      worker: { autoStart: false },
    });
    stop = null;
    warn.mockClear();
    sleep.mockClear();
  });
  afterEach(async () => {
    stop?.();
    await sync.close();
  });
  afterAll(removeTempDirs);

  function forward(opts: Partial<WebhookOptions> = {}) {
    stop = forwardEvents(sync, { url: HOOK, secret: "whsec_test", events: null, log: { warn }, sleep, ...opts });
  }

  /** Waits for the deliveries in flight to settle (they run in the background). */
  const settle = () => new Promise((r) => setTimeout(r, 20));

  const eventsOf = (calls: MockCall[]) => calls.map((c) => c.headers.get("x-post-sync-event"));

  it("signs each delivery so receivers can verify it", async () => {
    const { calls } = mockFetch([{ method: "POST", match: HOOK, reply: () => ({ status: 200, json: { ok: true } }) }]);
    forward();
    sync.events.emit("post.created", { post });
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    const [call] = calls;
    const body = String(call.body);
    const timestamp = call.headers.get("x-post-sync-timestamp")!;
    expect(Math.abs(Number(timestamp) - Date.now() / 1000)).toBeLessThan(60);
    const expected = "sha256=" + crypto.createHmac("sha256", "whsec_test").update(`${timestamp}.${body}`).digest("hex");
    expect(call.headers.get("x-post-sync-signature")).toBe(expected);
    expect(signWebhook("whsec_test", timestamp, body)).toBe(expected);
    expect(signWebhook("other-secret", timestamp, body)).not.toBe(expected);
    expect(signWebhook("whsec_test", String(Number(timestamp) + 1), body)).not.toBe(expected);

    expect(call.headers.get("content-type")).toBe("application/json");
    expect(call.headers.get("x-post-sync-event")).toBe("post.created");
    const parsed = JSON.parse(body);
    expect(parsed).toEqual({ id: call.headers.get("x-post-sync-delivery"), event: "post.created", data: { post }, createdAt: expect.any(Number) });
    await settle();
    expect(warn).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("sends no signature without a secret", async () => {
    const { calls } = mockFetch([{ method: "POST", match: HOOK, reply: () => ({ status: 204 }) }]);
    forward({ secret: null });
    sync.events.emit("target.succeeded", { target });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].headers.has("x-post-sync-signature")).toBe(false);
    expect(calls[0].headers.get("x-post-sync-timestamp")).toMatch(/^\d+$/);
  });

  it("retries 5xx answers and network errors with growing waits, re-signing the same delivery", async () => {
    const { calls } = mockFetch([
      {
        method: "POST",
        match: HOOK,
        reply: (_call, n) => (n === 1 ? { status: 503 } : n === 2 ? { error: new TypeError("fetch failed") } : { status: 200 }),
      },
    ]);
    forward();
    sync.events.emit("target.started", { target });
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    await settle();

    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 4000]);
    expect(warn).not.toHaveBeenCalled();
    expect(new Set(calls.map((c) => c.headers.get("x-post-sync-delivery"))).size).toBe(1);
    expect(new Set(calls.map((c) => String(c.body))).size).toBe(1);
    for (const c of calls) {
      expect(c.headers.get("x-post-sync-signature")).toBe(signWebhook("whsec_test", c.headers.get("x-post-sync-timestamp")!, String(c.body)));
    }
  });

  it("gives up after 4 attempts and logs a warning", async () => {
    const { calls } = mockFetch([{ method: "POST", match: HOOK, reply: () => ({ status: 500 }) }]);
    forward();
    sync.events.emit("post.created", { post });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(calls).toHaveLength(4);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 4000, 16000]);
    expect(warn.mock.calls[0][0]).toBe("webhook delivery of post.created to hooks.example.com failed");
  });

  it("doesn't retry a 400, but does retry 408 and 429", async () => {
    const { calls } = mockFetch([
      { method: "POST", match: `${HOOK}?bad`, reply: () => ({ status: 400 }) },
      { method: "POST", match: `${HOOK}?slow`, reply: (_call, n) => ({ status: n === 1 ? 408 : n === 2 ? 429 : 200 }) },
    ]);
    forward({ url: `${HOOK}?bad` });
    sync.events.emit("post.created", { post });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
    stop?.();

    calls.length = 0;
    warn.mockClear();
    forward({ url: `${HOOK}?slow` });
    sync.events.emit("post.created", { post });
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    await settle();
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it("sends every event except target.progress by default", async () => {
    const { calls } = mockFetch([{ method: "POST", match: HOOK, reply: () => ({ status: 200 }) }]);
    forward();
    sync.events.emit("target.progress", { target, message: "Uploading…" });
    sync.events.emit("target.succeeded", { target });
    sync.events.emit("target.failed", { target, error: "boom", willRetry: false, retryAt: null });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    await settle();
    expect(eventsOf(calls).sort()).toEqual(["target.failed", "target.succeeded"]);
  });

  it("sends only the configured events", async () => {
    const { calls } = mockFetch([{ method: "POST", match: HOOK, reply: () => ({ status: 200 }) }]);
    forward({ events: ["target.failed", "target.progress"] });
    sync.events.emit("post.created", { post });
    sync.events.emit("target.progress", { target, message: "Uploading…" });
    sync.events.emit("target.succeeded", { target });
    sync.events.emit("target.failed", { target, error: "boom", willRetry: true, retryAt: 123 });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    await settle();
    expect(eventsOf(calls).sort()).toEqual(["target.failed", "target.progress"]);
    const failed = calls.find((c) => c.headers.get("x-post-sync-event") === "target.failed")!;
    expect(JSON.parse(String(failed.body)).data).toEqual({ target, error: "boom", willRetry: true, retryAt: 123 });
  });

  it("stops forwarding once unsubscribed", async () => {
    const { calls } = mockFetch([{ method: "POST", match: HOOK, reply: () => ({ status: 200 }) }]);
    forward();
    stop!();
    sync.events.emit("post.created", { post });
    await settle();
    expect(calls).toHaveLength(0);
  });

  it("never lets a failing webhook break the engine", async () => {
    mockFetch([]);
    forward();
    expect(() => sync.events.emit("post.created", { post })).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(sleep).toHaveBeenCalledTimes(3);
  });
});
