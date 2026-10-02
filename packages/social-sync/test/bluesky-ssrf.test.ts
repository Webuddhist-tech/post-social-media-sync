import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePlatformKeys, serverOrigin, type Config } from "../src/config.js";
import { ApiError, AuthError, request, UserError } from "../src/http.js";
import { createHandler, createPostSync, type PostSync } from "../src/index.js";
import { bluesky, blueskyConnector, clearBlueskySessions, isPublicHostname } from "../src/platforms/bluesky.js";
import { sqliteStorage } from "../src/storage/sqlite.js";
import { fakeMedia, json, makeCtx, mockFetch, tempDir, TEST_SECRET, testConfig, type Route } from "./helpers.js";

const BSKY_PDS = "https://morel.us-east.host.bsky.network";
const CUSTOM = "https://pds.example.org";

const sessionBody = (pds: unknown, extra: Record<string, unknown> = {}) => ({
  did: "did:plc:me",
  handle: "me.example.org",
  accessJwt: "JWT",
  refreshJwt: "RJWT",
  didDoc: { service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: pds }] },
  ...extra,
});

const loginRoute = (server: string, pds: unknown): Route => ({
  method: "POST",
  match: `${server}/xrpc/com.atproto.server.createSession`,
  reply: () => ({ json: sessionBody(pds) }),
});

function connect(config: Config, service?: string) {
  return blueskyConnector.connectWithCredentials!(config, { identifier: "me.example.org", appPassword: "app-pass", ...(service === undefined ? {} : { service }) });
}

const customConfig = (servers: string[]) => testConfig({ bluesky: resolvePlatformKeys({ bluesky: { servers } }).bluesky });

/** The `redirect` option of every fetch made so far. */
const redirectModes = (fn: { mock: { calls: any[][] } }) => fn.mock.calls.map((c) => c[1]?.redirect);

beforeEach(() => clearBlueskySessions());

describe("Bluesky sign-in server", () => {
  const config = testConfig();

  it.each([
    ["http://127.0.0.1:9/admin?", "just the Bluesky server's address"],
    ["http://127.0.0.1:9", "isn't allowed"],
    ["http://127.0.0.1:9/admin?x=1", "just the Bluesky server's address"],
    ["https://evil.example/x?", "just the Bluesky server's address"],
    ["https://evil.example", "isn't allowed"],
    ["evil.example", "isn't allowed"],
    ["https://user:pass@bsky.social", "just the Bluesky server's address"],
    ["https://bsky.social@evil.example", "just the Bluesky server's address"],
    ["https://bsky.social/xrpc", "just the Bluesky server's address"],
    ["https://bsky.social#x", "just the Bluesky server's address"],
    ["https://bsky.social?", "just the Bluesky server's address"],
    ["http://bsky.social", "isn't allowed"],
    ["https://bsky.social:8443", "isn't allowed"],
    ["https://[::1]:2583", "isn't allowed"],
    ["ftp://bsky.social", "just the Bluesky server's address"],
    ["file:///etc/passwd", "just the Bluesky server's address"],
  ])("refuses %s before any request", async (service, message) => {
    const { fn } = mockFetch([]);
    const err = await connect(config, service).catch((e) => e);
    expect(err).toBeInstanceOf(UserError);
    expect(err.message).toContain(message);
    expect(fn).not.toHaveBeenCalled();
  });

  it.each(["", "  ", "bsky.social", "https://bsky.social", "https://bsky.social/", "HTTPS://BSKY.SOCIAL:443"])("signs in to bsky.social for %j", async (service) => {
    const { calls, fn } = mockFetch([loginRoute("https://bsky.social", BSKY_PDS), { match: `${BSKY_PDS}/xrpc/app.bsky.actor.getProfile`, reply: () => ({ json: {} }) }]);
    const [draft] = await connect(config, service);
    expect(draft.credentials.service).toBe("https://bsky.social");
    expect(calls[0].url.href).toBe("https://bsky.social/xrpc/com.atproto.server.createSession");
    expect(redirectModes(fn)).toEqual(["manual", "manual"]);
  });

  it("never follows a redirect from an allowed server, and doesn't echo it", async () => {
    const { calls, fn } = mockFetch([
      {
        match: "https://bsky.social/xrpc/com.atproto.server.createSession",
        reply: () => ({ status: 302, text: "internal secret", headers: { location: "http://127.0.0.1:8080/admin" } }),
      },
    ]);
    const err = await connect(config).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe("bsky.social answered with a redirect (302), which isn't followed.");
    expect(err.body).toBeNull();
    expect(calls).toHaveLength(1);
    expect(redirectModes(fn)).toEqual(["manual"]);
  });

  it("only offers the servers the host allows, the first being the default", async () => {
    const custom = customConfig(["pds.example.org/", "http://localhost:2583"]);
    expect(custom.bluesky.servers).toEqual([CUSTOM, "http://localhost:2583"]);
    mockFetch([loginRoute(CUSTOM, CUSTOM), loginRoute("http://localhost:2583", "http://localhost:2583"), { match: /getProfile/, reply: () => ({ json: {} }) }]);
    expect((await connect(custom))[0].credentials.service).toBe(CUSTOM);
    // http:// only works for an origin the host listed with http://.
    expect((await connect(custom, "http://localhost:2583"))[0].credentials.service).toBe("http://localhost:2583");
    await expect(connect(custom, "localhost:2583")).rejects.toThrow("isn't allowed");
    await expect(connect(custom, "https://bsky.social")).rejects.toThrow("isn't allowed");
  });
});

describe("Bluesky PDS from the sign-in answer", () => {
  it.each([
    "https://127.0.0.1",
    "https://10.0.0.5",
    "https://172.20.1.1",
    "https://192.168.1.10",
    "https://169.254.169.254",
    "https://[::1]",
    "https://[::ffff:127.0.0.1]",
    "https://[fd00::1]",
    "https://[fe80::1]",
    "https://localhost",
    "https://pds.localhost",
    "https://pds.example.net", // not where bsky.social hosts accounts
    "https://bsky.network.evil.example",
    "http://morel.us-east.host.bsky.network",
    "https://u:p@morel.us-east.host.bsky.network",
    "https://morel.us-east.host.bsky.network/admin",
    "https://morel.us-east.host.bsky.network/?x=1",
    "morel.us-east.host.bsky.network",
    "not a url",
    42,
  ])("refuses %s under bsky.social without calling it", async (pds) => {
    const { calls } = mockFetch([loginRoute("https://bsky.social", pds)]);
    const err = await connect(testConfig()).catch((e) => e);
    expect(err).toBeInstanceOf(UserError);
    expect(err.message).toContain("isn't allowed here");
    expect(calls).toHaveLength(1);
  });

  it.each(["https://10.0.0.1", "https://[::1]:443", "https://intranet", "https://metadata.google.internal", "https://pds.localhost", "http://other.example.com"])(
    "refuses %s under an allowed custom server",
    async (pds) => {
      const { calls } = mockFetch([loginRoute(CUSTOM, pds)]);
      await expect(connect(customConfig([CUSTOM]))).rejects.toThrow("isn't allowed here");
      expect(calls).toHaveLength(1);
    },
  );

  it("classifies hosts", () => {
    for (const host of ["127.0.0.1", "0.0.0.0", "100.64.0.1", "224.0.0.1", "[::]", "[::ffff:a00:1]", "[64:ff9b::a00:1]", "LOCALHOST.", "printer.local"]) {
      expect(isPublicHostname(host), host).toBe(false);
    }
    for (const host of ["8.8.8.8", "[2606:4700::1111]", "morel.us-east.host.bsky.network", "pds.example.org."]) {
      expect(isPublicHostname(host), host).toBe(true);
    }
  });
});

describe("an allowed custom server", () => {
  const OTHER_PDS = "https://other-pds.example.com";

  it("connects and publishes end to end", async () => {
    const config = customConfig([CUSTOM]);
    const { calls, fn } = mockFetch([
      loginRoute(CUSTOM, CUSTOM),
      { method: "GET", match: `${CUSTOM}/xrpc/app.bsky.actor.getProfile`, reply: () => ({ json: { displayName: "Me" } }) },
      { method: "POST", match: `${CUSTOM}/xrpc/com.atproto.repo.uploadBlob`, reply: () => ({ json: { blob: { $type: "blob", ref: { $link: "b" } } } }) },
      { method: "POST", match: `${CUSTOM}/xrpc/com.atproto.repo.createRecord`, reply: () => ({ json: { uri: "at://did:plc:me/app.bsky.feed.post/3kc" } }) },
    ]);
    const [draft] = await connect(config, CUSTOM);
    expect(draft).toMatchObject({ name: "Me", credentials: { service: CUSTOM } });
    const ctx = makeCtx(bluesky, { config, credentials: draft.credentials, input: { text: "hi", media: [fakeMedia(config, { kind: "image" })] } });
    expect((await bluesky.publish(ctx)).remoteId).toBe("at://did:plc:me/app.bsky.feed.post/3kc");
    expect(calls.map((c) => c.url.pathname)).toEqual([
      "/xrpc/com.atproto.server.createSession",
      "/xrpc/app.bsky.actor.getProfile",
      "/xrpc/com.atproto.server.createSession",
      "/xrpc/com.atproto.repo.uploadBlob",
      "/xrpc/com.atproto.repo.createRecord",
    ]);
    expect(calls.every((c) => c.url.origin === CUSTOM)).toBe(true);
    expect(json(calls[4]).record.text).toBe("hi");
    expect(redirectModes(fn).every((m) => m === "manual")).toBe(true);
  });

  it("keeps what a PDS on another host answers out of error messages", async () => {
    const config = customConfig([CUSTOM]);
    const creds = { identifier: "me.example.org", appPassword: "app-pass", service: CUSTOM };
    const publish = () => bluesky.publish(makeCtx(bluesky, { config, credentials: creds, input: { text: "hi" } }));
    let reply: () => any = () => ({ status: 500, text: "root:x:0:0 internal secret" });
    mockFetch([loginRoute(CUSTOM, OTHER_PDS), { method: "POST", match: `${OTHER_PDS}/xrpc/com.atproto.repo.createRecord`, reply: () => reply() }]);

    const e500 = await publish().catch((e) => e);
    expect(e500).toBeInstanceOf(ApiError);
    expect(e500.message).not.toContain("secret");
    expect(e500.message).toContain("other-pds.example.com returned 500");
    expect(e500.body).toBeNull();

    reply = () => ({ status: 400, json: { error: "InvalidRequest", message: "internal secret" } });
    const e400 = await publish().catch((e) => e);
    expect(e400.message).toBe("other-pds.example.com returned 400 (InvalidRequest).");
    expect(e400.body).toEqual({ error: "InvalidRequest" });

    reply = () => ({ status: 401, json: { error: "AuthMissing", message: "internal secret" } });
    const e401 = await publish().catch((e) => e);
    expect(e401).toBeInstanceOf(AuthError);
    expect(e401.message).not.toContain("secret");

    reply = () => {
      throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 10.0.0.5:443") });
    };
    const eNet = await publish().catch((e) => e);
    expect(eNet.message).toContain("Network error talking to other-pds.example.com.");
    expect(eNet.message).not.toContain("10.0.0.5");
  });

  it("still logs in afresh when such a PDS says the token expired", async () => {
    const config = customConfig([CUSTOM]);
    const { calls } = mockFetch([
      loginRoute(CUSTOM, OTHER_PDS),
      {
        method: "POST",
        match: `${OTHER_PDS}/xrpc/com.atproto.repo.createRecord`,
        reply: (_c, n) => (n === 1 ? { status: 400, json: { error: "ExpiredToken", message: "x" } } : { json: { uri: "at://x/app.bsky.feed.post/3kd" } }),
      },
    ]);
    const creds = { identifier: "me.example.org", appPassword: "app-pass", service: CUSTOM };
    const res = await bluesky.publish(makeCtx(bluesky, { config, credentials: creds, input: { text: "hi" } }));
    expect(res.remoteId).toBe("at://x/app.bsky.feed.post/3kd");
    expect(calls.filter((c) => c.url.pathname.endsWith("createSession"))).toHaveLength(2);
  });

  it("never shares a session between servers", async () => {
    const A = "https://a.example.com";
    const B = "https://b.example.com";
    const config = customConfig([A, B]);
    const { calls } = mockFetch([
      loginRoute(A, A),
      loginRoute(B, B),
      { method: "POST", match: /\/xrpc\/com\.atproto\.repo\.createRecord$/, reply: (c) => ({ json: { uri: `at://x/app.bsky.feed.post/${c.url.hostname[0]}` } }) },
    ]);
    const publish = (service: string) =>
      bluesky.publish(makeCtx(bluesky, { config, credentials: { identifier: "me", appPassword: "same", service }, input: { text: "hi" } }));
    expect((await publish(A)).remoteId).toBe("at://x/app.bsky.feed.post/a");
    expect((await publish(B)).remoteId).toBe("at://x/app.bsky.feed.post/b");
    expect((await publish(A)).remoteId).toBe("at://x/app.bsky.feed.post/a");
    expect(calls.filter((c) => c.url.pathname.endsWith("createSession")).map((c) => c.url.origin)).toEqual([A, B]);
  });
});

describe("saved Bluesky logins", () => {
  it.each(["http://127.0.0.1:9/admin?", "https://evil.example", "https://evil.example/x?", "https://bsky.social@evil.example"])(
    "refuses to publish or check with a saved server of %s",
    async (service) => {
      const config = testConfig();
      const { fn } = mockFetch([]);
      const credentials = { identifier: "me", appPassword: "p", service };
      const ctx = makeCtx(bluesky, { config, credentials, input: { text: "hi" } });
      await expect(bluesky.publish(ctx)).rejects.toThrow(AuthError);
      await expect(bluesky.publish(ctx)).rejects.toThrow("server isn't allowed here");
      await expect(bluesky.checkConnection({ account: ctx.account, config, credentials: async () => credentials })).rejects.toThrow(AuthError);
      expect(fn).not.toHaveBeenCalled();
    },
  );

  it("stops working once the host removes the server from the list", async () => {
    const { fn } = mockFetch([]);
    const ctx = makeCtx(bluesky, { config: testConfig(), credentials: { identifier: "me", appPassword: "p", service: CUSTOM }, input: { text: "hi" } });
    await expect(bluesky.publish(ctx)).rejects.toThrow("server isn't allowed here");
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("through the engine", () => {
  let sync: PostSync;
  beforeEach(async () => {
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

  it("answers the reported payload with 400 and no request, and keeps bodies out of 502s", async () => {
    const handler = createHandler(sync, { authenticate: () => "mallory" });
    const connectWith = (service: string) =>
      handler.fetch(
        new Request("https://app.example.com/social/connect/bluesky/credentials", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ fields: { identifier: "x", appPassword: "y", service } }),
        }),
      );
    const { fn } = mockFetch([{ match: "https://bsky.social/", reply: () => ({ status: 307, text: "secret", headers: { location: "http://10.0.0.1/" } }) }]);
    const payload = await connectWith("http://127.0.0.1:9/admin?");
    expect(payload.status).toBe(400);
    expect(((await payload.json()) as any).error).toBe("Enter just the Bluesky server's address, like https://bsky.social.");
    const refused = await connectWith("http://127.0.0.1:9");
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as any).error).toBe("This Bluesky server isn't allowed here. Ask the administrator to add it.");
    expect(fn).not.toHaveBeenCalled();

    const redirected = await connectWith("https://bsky.social");
    expect(redirected.status).toBe(502);
    expect(JSON.stringify(await redirected.json())).not.toMatch(/secret|10\.0\.0\.1/);
  });

  it("flags an account saved with a bad server instead of calling it", async () => {
    const { fn } = mockFetch([]);
    const [account] = await sync.accountService.saveDrafts("alice", "bluesky", [
      { platform: "bluesky", externalId: "did:plc:old", name: "Old", credentials: { identifier: "old", appPassword: "p", service: "http://127.0.0.1:9/admin?" } },
    ]);
    const check = await sync.accounts.check("alice", account.id);
    expect(check).toMatchObject({ ok: false, needsReconnect: true });
    expect(fn).not.toHaveBeenCalled();
  });

  it("rejects an invalid server list", async () => {
    for (const servers of [["https://pds.example.org/xrpc"], ["ftp://pds.example.org"], ["https://u:p@pds.example.org"], ["https://pds.example.org?x"]]) {
      await expect(
        createPostSync({ secret: TEST_SECRET, publicUrl: "https://app.example.com", storage: sqliteStorage(":memory:"), mediaDir: tempDir(), platforms: { bluesky: { servers } } }),
      ).rejects.toThrow("platforms.bluesky.servers");
    }
    expect(resolvePlatformKeys().bluesky.servers).toEqual(["https://bsky.social"]);
    expect(resolvePlatformKeys({ bluesky: { servers: [] } }).bluesky.servers).toEqual(["https://bsky.social"]);
  });
});

describe("serverOrigin", () => {
  it("keeps only bare server addresses", () => {
    expect(serverOrigin("bsky.social")).toBe("https://bsky.social");
    expect(serverOrigin(" https://PDS.Example.org:8443/ ")).toBe("https://pds.example.org:8443");
    expect(serverOrigin("http://localhost:2583")).toBe("http://localhost:2583");
    for (const bad of ["", "https://a.example/x", "https://a.example?", "https://a.example#", "https://u@a.example", "javascript:alert(1)", "https://a.example\\@b.example"]) {
      expect(serverOrigin(bad), bad).toBeNull();
    }
  });
});

describe("request() with redirect: manual", () => {
  const servers: http.Server[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });
  const listen = (handler: http.RequestListener) =>
    new Promise<string>((resolve) => {
      const server = http.createServer(handler).listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
      servers.push(server);
    });

  it("refuses the redirect without contacting its target", async () => {
    let internalHits = 0;
    const internal = await listen((_req, res) => {
      internalHits++;
      res.end("internal secret");
    });
    const front = await listen((_req, res) => {
      res.writeHead(302, { location: `${internal}/admin` }).end("moved");
    });
    const err = await request(`${front}/xrpc/x`, { redirect: "manual" }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 302, retryable: false, body: null });
    expect(err.message).not.toMatch(/moved|admin/);
    expect(internalHits).toBe(0);
    // Other callers still follow redirects.
    expect((await request(`${front}/xrpc/x`)).text).toBe("internal secret");
    expect(internalHits).toBe(1);
  });
});
