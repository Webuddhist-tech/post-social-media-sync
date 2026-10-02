import { sqliteStorage } from "post-social-media-sync/sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { API_TOKEN, dashboardConfig, mockFetch, removeTempDirs, tempDir } from "./helpers.js";

afterAll(removeTempDirs);

describe("BLUESKY_SERVERS", () => {
  beforeEach(() => {
    for (const name of ["PORT", "PUBLIC_BASE_URL", "DASHBOARD", "API_TOKEN", "WORKER", "DATABASE_URL", "BLUESKY_SERVERS"]) vi.stubEnv(name, undefined);
    vi.stubEnv("DATA_DIR", tempDir());
    vi.stubEnv("ADMIN_PASSWORD", "hunter22");
    vi.stubEnv("APP_SECRET", "s".repeat(40));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("leaves the default (bsky.social only) when unset", () => {
    expect(loadConfig().platforms.bluesky).toBeUndefined();
    vi.stubEnv("BLUESKY_SERVERS", " , ");
    expect(loadConfig().platforms.bluesky).toBeUndefined();
  });

  it("maps a comma list to origins", () => {
    vi.stubEnv("BLUESKY_SERVERS", "https://bsky.social, https://pds.example.org/ ,http://localhost:2583");
    expect(loadConfig().platforms.bluesky).toEqual({ servers: ["https://bsky.social", "https://pds.example.org", "http://localhost:2583"] });
  });

  it("refuses a value that isn't a URL", () => {
    vi.stubEnv("BLUESKY_SERVERS", "pds.example.org");
    expect(() => loadConfig()).toThrow(/BLUESKY_SERVERS must be a comma-separated list of URLs/);
  });
});

describe("connecting Bluesky through the API", () => {
  const CUSTOM = "https://pds.example.org";

  async function connect(servers: string[] | undefined, service: string) {
    const app = await buildServer({
      config: dashboardConfig({ platforms: servers ? { bluesky: { servers } } : {} }),
      storage: sqliteStorage(":memory:"),
      startWorker: false,
    });
    try {
      return await app.inject({
        method: "POST",
        url: "/api/connect/bluesky/credentials",
        headers: { authorization: `Bearer ${API_TOKEN}` },
        payload: { fields: { identifier: "me.example.org", appPassword: "app-pass", service } },
      });
    } finally {
      await app.close();
    }
  }

  it("refuses servers that aren't listed without contacting them", async () => {
    const { fn } = mockFetch([]);
    for (const service of ["http://127.0.0.1:8080/admin?", "https://evil.example", CUSTOM]) {
      const res = await connect(undefined, service);
      expect(res.statusCode, service).toBe(400);
    }
    expect((await connect([CUSTOM], "https://bsky.social")).json().error).toBe("This Bluesky server isn't allowed here. Ask the administrator to add it.");
    expect(fn).not.toHaveBeenCalled();
  });

  it("signs in to a listed server", async () => {
    const { calls } = mockFetch([
      {
        method: "POST",
        match: `${CUSTOM}/xrpc/com.atproto.server.createSession`,
        reply: () => ({
          json: {
            did: "did:plc:me",
            handle: "me.example.org",
            accessJwt: "JWT",
            didDoc: { service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: CUSTOM }] },
          },
        }),
      },
      { method: "GET", match: `${CUSTOM}/xrpc/app.bsky.actor.getProfile`, reply: () => ({ json: { displayName: "Me" } }) },
    ]);
    const res = await connect([CUSTOM], "");
    expect(res.statusCode).toBe(201);
    expect(res.json().accounts[0]).toMatchObject({ platform: "bluesky", name: "Me" });
    expect(calls.every((c) => c.url.origin === CUSTOM)).toBe(true);
  });
});
