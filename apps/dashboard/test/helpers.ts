import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import type { DashboardConfig } from "../src/config.js";

export const TEST_SECRET = "dashboard-test-secret-dashboard-test-secret";
export const API_TOKEN = "api-token-0123456789abcdef";
export const PASSWORD = "hunter22";
export const SITE = "https://posts.example.com";

const dirs: string[] = [];

export function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pss-dashboard-"));
  dirs.push(dir);
  return dir;
}

export function removeTempDirs(): void {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

/** A complete config for buildServer: dashboard on, no platform keys, no webhook. */
export function dashboardConfig(overrides: Partial<DashboardConfig> = {}): DashboardConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    siteUrl: SITE,
    trustProxy: false,
    dataDir: tempDir(),
    secret: TEST_SECRET,
    dashboard: true,
    adminPassword: PASSWORD,
    apiToken: API_TOKEN,
    runWorker: false,
    databaseUrl: null,
    maxUploadMb: 50,
    workerConcurrency: 2,
    maxAttempts: 3,
    platforms: {},
    webhook: null,
    allowedReturnOrigins: [],
    corsOrigins: [],
    remoteMediaHosts: [],
    ...overrides,
  };
}

export interface MockCall {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
}

type Reply = { status?: number; json?: unknown; text?: string; headers?: Record<string, string>; error?: Error };
export interface MockRoute {
  method?: string;
  match: string | RegExp;
  reply: (call: MockCall, n: number) => Reply | Promise<Reply>;
}

/** Replaces global fetch (restored after each test). Routes match in order; `n` counts hits per route. */
export function mockFetch(routes: MockRoute[]) {
  const calls: MockCall[] = [];
  const hits = new Map<MockRoute, number>();
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
    if (r.error) throw r.error;
    const status = r.status ?? 200;
    const body = status === 204 ? null : r.json !== undefined ? JSON.stringify(r.json) : (r.text ?? "");
    return new Response(body, { status, headers: { "content-type": "application/json", ...r.headers } });
  });
  vi.stubGlobal("fetch", fn);
  return { calls, fn };
}

export const PDS = "https://morel.us-east.host.bsky.network";

/** Bluesky XRPC mocks: any handle/app password logs in; posts get the record key "3kp". */
export function blueskyRoutes(): MockRoute[] {
  return [
    {
      method: "POST",
      match: "https://bsky.social/xrpc/com.atproto.server.createSession",
      reply: (call) => {
        const id = JSON.parse(String(call.body)).identifier as string;
        return {
          json: {
            did: `did:plc:${id.split(".")[0]}`,
            handle: id,
            accessJwt: "JWT",
            refreshJwt: "RJWT",
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

/** A Bluesky handle unique to this call, so the package's in-memory session cache never leaks between tests. */
export function uniqueHandle(): string {
  return `u${crypto.randomUUID().slice(0, 8)}.bsky.social`;
}

// 1x1 PNG
export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

/** Serializes FormData into a body and content-type usable with `app.inject`. */
export async function multipart(form: FormData): Promise<{ payload: Buffer; contentType: string }> {
  const req = new Request("http://localhost/", { method: "POST", body: form });
  return { payload: Buffer.from(await req.arrayBuffer()), contentType: req.headers.get("content-type")! };
}
