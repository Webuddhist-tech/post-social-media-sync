import { describe, expect, it } from "vitest";
import { isPrivateBaseUrl } from "../src/config.js";
import { pkceChallenge, Secrets } from "../src/crypto.js";
import { extractErrorMessage } from "../src/http.js";
import { detectFacets } from "../src/platforms/bluesky.js";
import { candidateVersions, toLittleText } from "../src/platforms/linkedin.js";
import { tiktokChunks } from "../src/platforms/tiktok.js";
import { youtubeTitle } from "../src/platforms/youtube.js";
import { graphemeLength, measureText, xLength } from "../src/text.js";
import { testConfig } from "./helpers.js";

const MB = 1024 * 1024;

describe("text length", () => {
  it("counts X links as 23 and emoji / CJK as 2", () => {
    expect(xLength("hello")).toBe(5);
    expect(xLength("see https://example.com/a/very/long/path?x=1")).toBe(4 + 23);
    expect(xLength("🙂")).toBe(2);
    expect(xLength("日本")).toBe(4);
  });

  it("counts Bluesky graphemes", () => {
    expect(graphemeLength("👍🏽")).toBe(1);
    expect(measureText("bluesky", "a👍🏽b")).toBe(3);
    expect(measureText("instagram", "a👍b")).toBe(3);
  });
});

describe("crypto", () => {
  const s = new Secrets("x".repeat(40));

  it("round-trips encrypted credentials", () => {
    const enc = s.encrypt({ token: "abc", n: 1 });
    expect(enc).not.toContain("abc");
    expect(s.decrypt(enc)).toEqual({ token: "abc", n: 1 });
  });

  it("detects tampering and wrong keys", () => {
    const enc = s.encrypt({ token: "abc" });
    const raw = Buffer.from(enc.slice(3), "base64");
    raw[raw.length - 1] ^= 1;
    expect(() => s.decrypt("v1:" + raw.toString("base64"))).toThrow();
    expect(() => new Secrets("y".repeat(40)).decrypt(enc)).toThrow();
  });

  it("signs and verifies", () => {
    const sig = s.sign("hello");
    expect(s.verify("hello", sig)).toBe(true);
    expect(s.verify("hellO", sig)).toBe(false);
  });

  it("computes RFC 7636 PKCE challenges", () => {
    // Example from RFC 7636 appendix B
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});

describe("config", () => {
  it("recognizes private base URLs", () => {
    expect(isPrivateBaseUrl("http://localhost:3000")).toBe(true);
    expect(isPrivateBaseUrl("http://192.168.1.20:3000")).toBe(true);
    expect(isPrivateBaseUrl("http://10.0.0.5")).toBe(true);
    expect(isPrivateBaseUrl("https://posts.example.com")).toBe(false);
    expect(isPrivateBaseUrl("https://abc.trycloudflare.com")).toBe(false);
  });
});

describe("error messages", () => {
  it("understands each platform's error shape", () => {
    expect(extractErrorMessage({ error: { message: "Invalid parameter", code: 100, error_subcode: 33 } })).toBe("Invalid parameter [100/33]");
    expect(extractErrorMessage({ error: { code: "spam_risk", message: "Too many posts", log_id: "x" } })).toBe("Too many posts [spam_risk]");
    expect(extractErrorMessage({ error: "invalid_grant", error_description: "Bad code" })).toBe("invalid_grant: Bad code");
    expect(extractErrorMessage({ error: "AuthenticationRequired", message: "Invalid identifier or password" })).toBe(
      "AuthenticationRequired: Invalid identifier or password",
    );
    expect(extractErrorMessage({ title: "Forbidden", detail: "Not permitted" })).toBe("Forbidden: Not permitted");
    expect(extractErrorMessage({ message: "Resource not found", status: 404 })).toBe("Resource not found");
  });
});

describe("LinkedIn", () => {
  it("escapes little-text reserved characters and keeps hashtags clickable", () => {
    expect(toLittleText("Hello (world) [x] @me *bold* a_b ~ <tag> {x} | \\")).toBe(
      "Hello \\(world\\) \\[x\\] \\@me \\*bold\\* a\\_b \\~ \\<tag\\> \\{x\\} \\| \\\\",
    );
    expect(toLittleText("Join us #meditation #day_1!")).toBe("Join us {hashtag|\\#|meditation} {hashtag|\\#|day\\_1}!");
    expect(toLittleText("issue#5 and https://x.com/#anchor")).toBe("issue\\#5 and https://x.com/\\#anchor");
  });

  it("tries the last 12 monthly API versions newest first", () => {
    const versions = candidateVersions(testConfig(), new Date(Date.UTC(2026, 0, 15)));
    expect(versions[0]).toBe("202601");
    expect(versions[1]).toBe("202512");
    expect(versions).toHaveLength(12);
    expect(candidateVersions(testConfig({ linkedin: { clientId: "", clientSecret: "", version: "202507", organizations: false } }))).toEqual([
      "202507",
    ]);
  });
});

describe("TikTok chunking", () => {
  it("uploads small files in one chunk", () => {
    expect(tiktokChunks(3 * MB)).toEqual({ chunkSize: 3 * MB, count: 1, ranges: [[0, 3 * MB - 1]] });
    expect(tiktokChunks(60 * MB).count).toBe(1);
  });

  it("splits big files into 16 MB chunks with the remainder in the last one", () => {
    const size = 70 * MB + 123;
    const { chunkSize, count, ranges } = tiktokChunks(size);
    expect(chunkSize).toBe(16 * MB);
    expect(count).toBe(Math.floor(size / chunkSize));
    expect(ranges[0]).toEqual([0, 16 * MB - 1]);
    expect(ranges.at(-1)![1]).toBe(size - 1);
    const last = ranges.at(-1)!;
    expect(last[1] - last[0] + 1).toBeLessThanOrEqual(128 * MB);
    // contiguous
    for (let i = 1; i < ranges.length; i++) expect(ranges[i][0]).toBe(ranges[i - 1][1] + 1);
  });
});

describe("YouTube titles", () => {
  it("uses the title, else the first caption line, max 100 chars without < >", () => {
    expect(youtubeTitle("My <video>", "x")).toBe("My video");
    expect(youtubeTitle(null, "\nFirst line\nsecond")).toBe("First line");
    const long = youtubeTitle(null, "a".repeat(150));
    expect(long.length).toBe(100);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("Bluesky facets", () => {
  it("uses UTF-8 byte offsets for links, tags and mentions", async () => {
    const text = "🙂 see https://example.com/x. #calm @alice.bsky.social";
    const facets = await detectFacets(text, async (h) => (h === "alice.bsky.social" ? "did:plc:alice" : null));
    const slice = (f: (typeof facets)[number]) =>
      Buffer.from(text, "utf8").subarray(f.index.byteStart, f.index.byteEnd).toString("utf8");
    expect(facets.map(slice)).toEqual(["https://example.com/x", "#calm", "@alice.bsky.social"]);
    expect(facets[0].features[0]).toEqual({ $type: "app.bsky.richtext.facet#link", uri: "https://example.com/x" });
    expect(facets[1].features[0]).toEqual({ $type: "app.bsky.richtext.facet#tag", tag: "calm" });
    expect(facets[2].features[0]).toEqual({ $type: "app.bsky.richtext.facet#mention", did: "did:plc:alice" });
  });

  it("skips mentions that don't resolve", async () => {
    expect(await detectFacets("hi @nobody.example", async () => null)).toEqual([]);
  });
});
