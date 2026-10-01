import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import type { Config } from "../src/config.js";
import { Secrets } from "../src/crypto.js";
import { openDatabase } from "../src/db.js";
import { MediaStore, type MediaFile } from "../src/media.js";
import type { AccountInfo, Platform, PublishContext, PublishInput } from "../src/platforms/types.js";
import { withDefaults } from "../src/posts.js";

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pss-test-"));
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  const dataDir = tempDir();
  const mediaDir = path.join(dataDir, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  return {
    port: 0,
    host: "127.0.0.1",
    publicBaseUrl: "https://posts.example.com",
    dataDir,
    mediaDir,
    appSecret: "test-secret-test-secret-test-secret-123",
    adminPassword: "hunter22",
    apiToken: "api-token-123",
    maxUploadBytes: 50 * 1024 * 1024,
    workerConcurrency: 2,
    maxAttempts: 3,
    meta: { appId: "meta-app", appSecret: "meta-secret", graphVersion: "v26.0", loginConfigId: null, extraScopes: [] },
    threads: { appId: "th-app", appSecret: "th-secret" },
    tiktok: { clientKey: "tt-key", clientSecret: "tt-secret", scopes: "user.info.basic,video.publish,video.upload" },
    linkedin: { clientId: "li-id", clientSecret: "li-secret", version: null, organizations: false },
    google: { clientId: "g-id", clientSecret: "g-secret" },
    x: { clientId: "x-id", clientSecret: "x-secret" },
    ...overrides,
  };
}

export interface MockCall {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
}

type Reply = { status?: number; json?: unknown; text?: string; headers?: Record<string, string> };
export interface Route {
  method?: string;
  match: string | RegExp;
  reply: (call: MockCall, n: number) => Reply | Promise<Reply>;
}

/** Replaces global fetch. Routes are matched in order; `n` counts how often a route was hit. */
export function mockFetch(routes: Route[]) {
  const calls: MockCall[] = [];
  const hits = new Map<Route, number>();
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const call: MockCall = { method, url, headers: new Headers(init?.headers), body: init?.body };
    calls.push(call);
    const route = routes.find(
      (r) => (!r.method || r.method === method) && (typeof r.match === "string" ? url.href.startsWith(r.match) : r.match.test(url.href)),
    );
    if (!route) throw new TypeError(`fetch failed (unmocked ${method} ${url.href})`);
    const n = (hits.get(route) ?? 0) + 1;
    hits.set(route, n);
    const r = await route.reply(call, n);
    const status = r.status ?? 200;
    const body = status === 204 ? null : r.json !== undefined ? JSON.stringify(r.json) : (r.text ?? "");
    return new Response(body, { status, headers: { "content-type": "application/json", ...r.headers } });
  });
  vi.stubGlobal("fetch", fn);
  return { calls, fn };
}

/** Form fields of a urlencoded body, or the raw value. */
export function form(call: MockCall): Record<string, string> {
  if (call.body instanceof URLSearchParams) return Object.fromEntries(call.body);
  if (call.body instanceof FormData) {
    return Object.fromEntries([...call.body.entries()].map(([k, v]) => [k, typeof v === "string" ? v : `<file:${(v as File).size}>`]));
  }
  return {};
}

export function json(call: MockCall): any {
  return JSON.parse(String(call.body));
}

/** Writes a fake media file of `size` bytes and returns it as a MediaFile. */
export function fakeMedia(config: Config, opts: Partial<MediaFile> & { kind: "image" | "video"; size?: number }): MediaFile {
  const id = opts.id ?? crypto.randomUUID();
  const ext = opts.kind === "video" ? ".mp4" : ".jpg";
  const file = id + ext;
  const p = path.join(config.mediaDir, file);
  const size = opts.size ?? 1000;
  fs.writeFileSync(p, Buffer.alloc(size, 7));
  return {
    id,
    filename: opts.filename ?? `clip${ext}`,
    file,
    path: p,
    mime: opts.mime ?? (opts.kind === "video" ? "video/mp4" : "image/jpeg"),
    kind: opts.kind,
    size,
    width: opts.width ?? (opts.kind === "video" ? 1080 : 1200),
    height: opts.height ?? (opts.kind === "video" ? 1920 : 1200),
    duration: opts.kind === "video" ? (opts.duration ?? 12) : null,
  };
}

export function makeCtx(
  platform: Platform,
  opts: {
    config: Config;
    account?: Partial<AccountInfo>;
    credentials: Record<string, any>;
    input: Partial<PublishInput>;
  },
): PublishContext & { progressLog: string[] } {
  const db = openDatabase(":memory:");
  const media = new MediaStore(db, opts.config, new Secrets(opts.config.appSecret));
  const progressLog: string[] = [];
  return {
    account: {
      id: "acc-1",
      platform: platform.id,
      externalId: "ext-1",
      name: "Test Account",
      username: "tester",
      meta: {},
      ...opts.account,
    },
    input: {
      text: "",
      title: null,
      media: [],
      ...opts.input,
      options: withDefaults(platform, opts.input.options ?? {}),
    },
    config: opts.config,
    media,
    credentials: async () => opts.credentials,
    progress: (m) => progressLog.push(m),
    sleep: async () => {},
    progressLog,
  };
}
