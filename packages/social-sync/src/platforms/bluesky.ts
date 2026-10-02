import crypto from "node:crypto";
import net from "node:net";
import { DEFAULT_BLUESKY_SERVERS, serverOrigin, type Config } from "../config.js";
import { ApiError, AuthError, publishStep, request, UserError, type HttpResponse, type RequestOptions } from "../http.js";
import { fileBlob, readRange, type MediaFile } from "../media.js";
import { graphemeLength } from "../text.js";
import { pollUntil } from "./common.js";
import type { Connector, Platform, PublishContext, PublishResult } from "./types.js";

interface BlueskyCredentials {
  identifier: string;
  appPassword: string;
  service: string;
}

interface Session {
  did: string;
  handle: string;
  accessJwt: string;
  pds: string;
  /** The PDS is the sign-in server itself or Bluesky's own: its error messages may be shown. */
  trusted: boolean;
}

const MAX_IMAGE_BYTES = 2_000_000; // per image (raised from 1 MB in 2026); images display at up to 4000 px
const MAX_VIDEO_BYTES = 300_000_000;
const MAX_VIDEO_SECONDS = 10 * 60;
const BSKY_SOCIAL = "https://bsky.social";

// ---- servers ----------------------------------------------------------------------------
// The sign-in server comes from the user and the PDS from that server's answer: both are checked before any request,
// so nobody can make this server call hosts on its own network.

const allowedServers = (config: Config) => (config.bluesky?.servers?.length ? config.bluesky.servers : DEFAULT_BLUESKY_SERVERS);

/** The sign-in server the user typed (empty: the first allowed one), as an allow-listed origin. */
function signInServer(config: Config, input: string | undefined): string {
  if (!input?.trim()) return allowedServers(config)[0];
  const origin = serverOrigin(input);
  if (!origin) throw new UserError("Enter just the Bluesky server's address, like https://bsky.social.");
  if (!allowedServers(config).includes(origin)) {
    throw new UserError("This Bluesky server isn't allowed here. Ask the administrator to add it.");
  }
  return origin;
}

/** Saved credentials, with their server checked again (accounts saved before the allow-list, or since removed from it). */
function savedCredentials(config: Config, c: Partial<BlueskyCredentials> | null): BlueskyCredentials {
  if (!c?.identifier || !c.appPassword || !c.service) throw new AuthError("The saved Bluesky login is incomplete. Reconnect the account.");
  const origin = serverOrigin(c.service);
  if (!origin || !allowedServers(config).includes(origin)) {
    throw new AuthError("This Bluesky account's server isn't allowed here. Reconnect it, or ask the administrator to add the server.");
  }
  return { identifier: c.identifier, appPassword: c.appPassword, service: origin };
}

const PRIVATE_IPS = new net.BlockList();
for (const [prefix, bits] of [
  ["0.0.0.0", 8], // unspecified, "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local (cloud metadata)
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["224.0.0.0", 3], // multicast, reserved, broadcast
] as const) {
  PRIVATE_IPS.addSubnet(prefix, bits, "ipv4");
}
for (const [prefix, bits] of [
  ["::", 96], // unspecified, loopback, IPv4-compatible (IPv4-mapped ones are checked against the IPv4 ranges)
  ["64:ff9b::", 96], // NAT64
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local
  ["ff00::", 8], // multicast
] as const) {
  PRIVATE_IPS.addSubnet(prefix, bits, "ipv6");
}

/** A hostname that may be on the public internet: no localhost, no private/loopback/link-local IP, no bare intranet name. */
export function isPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const ip = host.startsWith("[") ? host.slice(1, -1) : host;
  const version = net.isIP(ip);
  if (version) return !PRIVATE_IPS.check(ip, version === 6 ? "ipv6" : "ipv4");
  return host.includes(".") && !/(^|\.)(localhost|local|internal)$/.test(host);
}

/**
 * The account's PDS from the sign-in server's answer, as an origin: the sign-in server itself, or a public https
 * server. bsky.social only hands out its own PDSes (*.bsky.network).
 */
function checkPds(endpoint: unknown, service: string): string {
  const origin = typeof endpoint === "string" && /^https?:\/\//i.test(endpoint.trim()) ? serverOrigin(endpoint) : null;
  if (origin && origin === service) return origin;
  const host = origin?.startsWith("https://") ? new URL(origin).hostname.replace(/\.$/, "") : null;
  if (!origin || !host || !isPublicHostname(host) || (service === BSKY_SOCIAL && !host.endsWith(".bsky.network"))) {
    throw new UserError("Bluesky named a server for this account that isn't allowed here, so nothing was sent to it.");
  }
  return origin;
}

/** `fallbackPds`: where the account lives when the answer has no DID document (the sign-in server, or the cached PDS). */
function toSession(d: any, service: string, fallbackPds = service): Session {
  const endpoint = d?.didDoc?.service?.find?.((s: any) => String(s?.id).endsWith("#atproto_pds"))?.serviceEndpoint ?? fallbackPds;
  const pds = checkPds(endpoint, service);
  const trusted = pds === service || new URL(pds).hostname.replace(/\.$/, "").endsWith(".bsky.network");
  return { did: d.did, handle: d.handle, accessJwt: d.accessJwt, pds, trusted };
}

// ---- requests ---------------------------------------------------------------------------

/** Every Bluesky request: a redirect could point anywhere, so it is never followed. */
const call = <T = any>(url: string, opts: RequestOptions = {}): Promise<HttpResponse<T>> =>
  request<T>(url, { ...opts, redirect: "manual" });

/** The same error without what the server wrote (only its XRPC error name, which the retry logic reads). */
function withoutBody(err: unknown, url: string): unknown {
  const host = new URL(url).host;
  if (err instanceof AuthError) return new AuthError(`${host} rejected the access token (401).`);
  if (!(err instanceof ApiError)) return err;
  const name = (err.body as any)?.error;
  const code = typeof name === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) ? name : null;
  const message = err.status ? `${host} returned ${err.status}${code ? ` (${code})` : ""}.` : `Network error talking to ${host}.`;
  return new ApiError(message, err.status, code ? { error: code } : null, err.retryable, err);
}

/** Calls the account's PDS. Error details only come back from a PDS we can vouch for. */
async function xrpc<T = any>(s: Session, method: string, opts: RequestOptions = {}): Promise<HttpResponse<T>> {
  const url = `${s.pds}/xrpc/${method}`;
  try {
    return await call<T>(url, opts);
  } catch (err) {
    throw s.trusted ? err : withoutBody(err, url);
  }
}

const auth = (s: Session) => ({ Authorization: `Bearer ${s.accessJwt}` });

async function createSession(c: BlueskyCredentials): Promise<Session & { refreshJwt: string }> {
  const res = await call(`${c.service}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    json: { identifier: c.identifier, password: c.appPassword },
  });
  return { ...toSession(res.data, c.service), refreshJwt: res.data.refreshJwt };
}

/**
 * createSession is limited to 30 logins per 5 minutes / 300 per day per account, so sessions are reused for up to an
 * hour and then renewed with refreshSession. Keyed by the server and the password too, so reconnecting with a new app
 * password works and two servers never share a session.
 */
const sessions = new Map<string, { session: Session; refreshJwt: string; at: number }>();
const sessionKey = (c: BlueskyCredentials) =>
  `${c.service}|${c.identifier}|${crypto.createHash("sha256").update(c.appPassword).digest("hex").slice(0, 16)}`;

async function getSession(c: BlueskyCredentials, opts: { verify?: boolean } = {}): Promise<Session> {
  const key = sessionKey(c);
  const cached = sessions.get(key);
  // `verify` always talks to the server (refreshSession fails once the app password is revoked).
  if (cached && !opts.verify && Date.now() - cached.at < 60 * 60_000) return cached.session;
  if (cached) {
    try {
      const res = await xrpc(cached.session, "com.atproto.server.refreshSession", {
        method: "POST",
        headers: { Authorization: `Bearer ${cached.refreshJwt}` },
      });
      const session = toSession(res.data, c.service, cached.session.pds);
      sessions.set(key, { session, refreshJwt: res.data.refreshJwt, at: Date.now() });
      return session;
    } catch {
      sessions.delete(key); // fall back to a fresh login
    }
  }
  const { refreshJwt, ...session } = await createSession(c);
  sessions.set(key, { session, refreshJwt, at: Date.now() });
  return session;
}

export function clearBlueskySessions(): void {
  sessions.clear();
}

export const blueskyConnector: Connector = {
  id: "bluesky",
  name: "Bluesky",
  platforms: ["bluesky"],
  kind: "credentials",
  isConfigured: () => true,
  credentialFields: [
    { key: "identifier", label: "Handle or email", type: "text", placeholder: "you.bsky.social", required: true },
    {
      key: "appPassword",
      label: "App password",
      type: "password",
      placeholder: "xxxx-xxxx-xxxx-xxxx",
      help: "Create one in Bluesky → Settings → Privacy and security → App passwords. Don't use your main password.",
      required: true,
    },
    { key: "service", label: "Server (optional)", type: "url", placeholder: "https://bsky.social" },
  ],

  async connectWithCredentials(config, fields) {
    const identifier = (fields.identifier ?? "").trim().replace(/^@/, "");
    const appPassword = (fields.appPassword ?? "").trim();
    if (!identifier || !appPassword) throw new UserError("Enter your Bluesky handle and an app password.");
    const creds: BlueskyCredentials = { identifier, appPassword, service: signInServer(config, fields.service) };
    const session = await createSession(creds);
    let profile: any = {};
    try {
      profile = (await xrpc(session, "app.bsky.actor.getProfile", { query: { actor: session.did }, headers: auth(session) })).data ?? {};
    } catch {
      // cosmetic
    }
    return [
      {
        platform: "bluesky",
        externalId: session.did,
        name: profile.displayName || session.handle,
        username: session.handle,
        avatarUrl: profile.avatar ?? null,
        credentials: creds,
        expiresAt: null,
      },
    ];
  },
};

// ---- rich text facets ---------------------------------------------------------

interface Facet {
  index: { byteStart: number; byteEnd: number };
  features: Array<Record<string, string>>;
}

const byteOffset = (text: string, charIndex: number) => Buffer.byteLength(text.slice(0, charIndex), "utf8");

// Ported from Bluesky's own detector (@atproto/api rich-text/util.ts + detection.ts).
const MENTION_RE = /(^|\s|\()(@)([a-zA-Z0-9.-]+)(\b)/g;
const LINK_RE = /(^|\s|\()(https?:\/\/\S+)/gim;
// eslint-disable-next-line no-misleading-character-class
const TAG_RE =
  /(^|\s)[#＃]((?!\ufe0f)[^\s\u00AD\u2060\u200A\u200B\u200C\u200D\u20e2]*[^\d\s\p{P}\u00AD\u2060\u200A\u200B\u200C\u200D\u20e2]+[^\s\u00AD\u2060\u200A\u200B\u200C\u200D\u20e2]*)?/gu;

/** Links, #hashtags and @mentions need explicit "facets" (with UTF-8 byte offsets) to be clickable on Bluesky. */
export async function detectFacets(text: string, resolveHandle: (handle: string) => Promise<string | null>): Promise<Facet[]> {
  const facets: Facet[] = [];
  const add = (start: number, end: number, feature: Record<string, string>) =>
    facets.push({ index: { byteStart: byteOffset(text, start), byteEnd: byteOffset(text, end) }, features: [feature] });

  for (const m of text.matchAll(LINK_RE)) {
    let uri = m[2];
    const start = m.index! + m[1].length;
    if (/[.,;:!?]$/.test(uri)) uri = uri.slice(0, -1);
    if (/[)]$/.test(uri) && !uri.includes("(")) uri = uri.slice(0, -1);
    add(start, start + uri.length, { $type: "app.bsky.richtext.facet#link", uri });
  }
  for (const m of text.matchAll(TAG_RE)) {
    const tag = (m[2] ?? "").trim().replace(/\p{P}+$/gu, "");
    if (!tag || graphemeLength(tag) > 64) continue;
    const start = m.index! + m[1].length;
    add(start, start + 1 + tag.length, { $type: "app.bsky.richtext.facet#tag", tag });
  }
  for (const m of text.matchAll(MENTION_RE)) {
    const handle = m[3];
    if (!/^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+$/.test(handle)) continue; // not a handle
    const did = await resolveHandle(handle);
    if (!did) continue;
    const start = m.index! + m[1].length;
    add(start, start + 1 + handle.length, { $type: "app.bsky.richtext.facet#mention", did });
  }
  return facets.sort((a, b) => a.index.byteStart - b.index.byteStart);
}

// ---- media ------------------------------------------------------------------------

async function uploadImage(ctx: PublishContext, s: Session, m: MediaFile) {
  const ok = ["image/jpeg", "image/png", "image/webp"].includes(m.mime) && m.size <= MAX_IMAGE_BYTES;
  const img = ok ? m : await ctx.media.jpegVariant(m, { maxBytes: MAX_IMAGE_BYTES, maxDimension: 4000 });
  const res = await xrpc(s, "com.atproto.repo.uploadBlob", {
    method: "POST",
    headers: { ...auth(s), "Content-Type": img.mime },
    body: await readRange(img.path, 0, img.size - 1),
  });
  return {
    alt: "",
    image: res.data.blob,
    ...(img.width && img.height ? { aspectRatio: { width: img.width, height: img.height } } : {}),
  };
}

/** Uploads through Bluesky's video service so the post only appears once the video is processed. */
async function uploadVideo(ctx: PublishContext, s: Session, m: MediaFile) {
  const serviceAuth = await xrpc(s, "com.atproto.server.getServiceAuth", {
    headers: auth(s),
    query: {
      aud: `did:web:${new URL(s.pds).host}`,
      lxm: "com.atproto.repo.uploadBlob",
      exp: Math.floor(Date.now() / 1000) + 30 * 60,
    },
  });
  ctx.progress(`Uploading video (${(m.size / 1024 / 1024).toFixed(1)} MB) to Bluesky…`);
  const isM4v = m.mime === "video/x-m4v"; // an MP4 container; the video service only knows video/mp4
  const upload = await call("https://video.bsky.app/xrpc/app.bsky.video.uploadVideo", {
    method: "POST",
    query: { did: s.did, name: `${m.id}${isM4v ? ".mp4" : m.file.slice(m.file.lastIndexOf("."))}` },
    headers: { Authorization: `Bearer ${serviceAuth.data.token}`, "Content-Type": isM4v ? "video/mp4" : m.mime },
    body: await fileBlob(m),
    okStatuses: [409], // "already_exists": same video uploaded before; the body still has the job id
    timeoutMs: 30 * 60_000,
  });
  const job = upload.data?.jobStatus ?? upload.data;
  let blob = job?.blob;
  if (!blob) {
    if (!job?.jobId) throw new ApiError(`Bluesky video upload failed: ${job?.error ?? job?.message ?? "no job id"}`, upload.status, upload.data, false);
    ctx.progress("Waiting for Bluesky to process the video…");
    blob = await pollUntil(
      ctx.sleep,
      async () => {
        const st = (await call("https://video.bsky.app/xrpc/app.bsky.video.getJobStatus", { query: { jobId: job.jobId } })).data.jobStatus;
        // A failed job can still carry a usable blob (e.g. "already_exists" for a video processed before).
        if (st.blob) return st.blob;
        if (st.state === "JOB_STATE_FAILED") throw new Error(`Bluesky couldn't process the video: ${st.error ?? st.message ?? "unknown error"}`);
        if (st.state === "JOB_STATE_COMPLETED") throw new Error("Bluesky finished processing the video but didn't return it.");
        return null;
      },
      { intervalMs: 2000, timeoutMs: 20 * 60_000, what: "Bluesky to process the video", tolerateTransientErrors: true },
    );
  }
  return {
    $type: "app.bsky.embed.video",
    video: blob,
    ...(m.width && m.height ? { aspectRatio: { width: m.width, height: m.height } } : {}),
  };
}

export const bluesky: Platform = {
  id: "bluesky",
  name: "Bluesky",
  connector: "bluesky",
  capabilities: {
    textOnly: true,
    maxTextLength: 300,
    maxImages: 4,
    video: true,
    mixedMedia: false,
    needsPublicMediaUrl: false,
    usesTitle: false,
  },
  options: [],

  validate(input) {
    const errors: string[] = [];
    const video = input.media.find((m) => m.kind === "video");
    if (video && video.size > MAX_VIDEO_BYTES) errors.push("Bluesky videos must be 300 MB or smaller.");
    if (video?.duration && video.duration > MAX_VIDEO_SECONDS) errors.push("Bluesky videos can be at most 10 minutes long.");
    return errors;
  },

  async publish(ctx) {
    const creds = savedCredentials(ctx.config, await ctx.credentials());
    ctx.progress("Signing in to Bluesky…");
    const reused = sessions.has(sessionKey(creds));
    try {
      return await publishWithSession(ctx, await getSession(creds));
    } catch (err) {
      const expired = err instanceof ApiError && ["ExpiredToken", "InvalidToken"].includes((err.body as any)?.error);
      if (!expired && !(err instanceof AuthError)) throw err;
      sessions.delete(sessionKey(creds));
      // A reused session may have been revoked or expired early: log in afresh once before giving up.
      if (reused || expired) return publishWithSession(ctx, await getSession(creds));
      throw err;
    }
  },

  async checkConnection(ctx) {
    const s = await getSession(savedCredentials(ctx.config, await ctx.credentials()), { verify: true });
    const info = (await xrpc(s, "com.atproto.server.getSession", { headers: auth(s) })).data;
    if (info.active === false) throw new UserError(`The Bluesky account is ${info.status ?? "inactive"}.`);
    return `Can post as @${info.handle ?? s.handle}.`;
  },
};

async function publishWithSession(ctx: PublishContext, s: Session): Promise<PublishResult> {
  const { text, media } = ctx.input;

  let embed: Record<string, unknown> | undefined;
  if (media.length && media[0].kind === "video") {
    embed = await uploadVideo(ctx, s, media[0]);
  } else if (media.length) {
    const images = [];
    for (const [i, m] of media.entries()) {
      ctx.progress(`Uploading image ${i + 1} of ${media.length} to Bluesky…`);
      images.push(await uploadImage(ctx, s, m));
    }
    embed = { $type: "app.bsky.embed.images", images };
  }

  const facets = await detectFacets(text, async (handle) => {
    try {
      return (await xrpc(s, "com.atproto.identity.resolveHandle", { query: { handle } })).data.did ?? null;
    } catch {
      return null;
    }
  });

  ctx.progress("Posting to Bluesky…");
  const res = await publishStep("Bluesky", () =>
    xrpc(s, "com.atproto.repo.createRecord", {
      method: "POST",
      headers: auth(s),
      json: {
        repo: s.did,
        collection: "app.bsky.feed.post",
        record: {
          $type: "app.bsky.feed.post",
          text,
          createdAt: new Date().toISOString(),
          ...(facets.length ? { facets } : {}),
          ...(embed ? { embed } : {}),
        },
      },
    }),
  );
  const uri: string = res.data.uri;
  const rkey = uri.split("/").pop();
  return { remoteId: uri, url: `https://bsky.app/profile/${s.handle}/post/${rkey}` };
}
