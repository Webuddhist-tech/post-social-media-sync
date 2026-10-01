import crypto from "node:crypto";
import { ApiError, AuthError, publishStep, request, UserError } from "../http.js";
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
}

const MAX_IMAGE_BYTES = 2_000_000; // per image (raised from 1 MB in 2026); images display at up to 4000 px
const MAX_VIDEO_BYTES = 300_000_000;
const MAX_VIDEO_SECONDS = 10 * 60;

function normalizeService(service: string | undefined): string {
  const s = (service || "https://bsky.social").trim().replace(/\/+$/, "");
  return /^https?:\/\//.test(s) ? s : `https://${s}`;
}

function toSession(d: any, fallbackService: string): Session {
  const pds = d.didDoc?.service?.find((s: any) => String(s.id).endsWith("#atproto_pds"))?.serviceEndpoint ?? fallbackService;
  return { did: d.did, handle: d.handle, accessJwt: d.accessJwt, pds: String(pds).replace(/\/+$/, "") };
}

async function createSession(c: BlueskyCredentials): Promise<Session & { refreshJwt: string }> {
  const res = await request(`${c.service}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    json: { identifier: c.identifier, password: c.appPassword },
  });
  return { ...toSession(res.data, c.service), refreshJwt: res.data.refreshJwt };
}

/**
 * createSession is limited to 30 logins per 5 minutes / 300 per day per account, so sessions are reused for up to an
 * hour and then renewed with refreshSession. Keyed by the password too, so reconnecting with a new app password works.
 */
const sessions = new Map<string, { session: Session; refreshJwt: string; at: number }>();
const sessionKey = (c: BlueskyCredentials) =>
  `${c.service}|${c.identifier}|${crypto.createHash("sha256").update(c.appPassword).digest("hex").slice(0, 16)}`;

async function getSession(c: BlueskyCredentials): Promise<Session> {
  if (!c.identifier || !c.appPassword || !c.service) throw new AuthError("The saved Bluesky login is incomplete. Reconnect the account.");
  const key = sessionKey(c);
  const cached = sessions.get(key);
  if (cached && Date.now() - cached.at < 60 * 60_000) return cached.session;
  if (cached) {
    try {
      const res = await request(`${cached.session.pds}/xrpc/com.atproto.server.refreshSession`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cached.refreshJwt}` },
      });
      const session = toSession(res.data, cached.session.pds);
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

const xrpc = (s: Session, method: string) => `${s.pds}/xrpc/${method}`;
const auth = (s: Session) => ({ Authorization: `Bearer ${s.accessJwt}` });

export const blueskyConnector: Connector = {
  id: "bluesky",
  name: "Bluesky",
  platforms: ["bluesky"],
  kind: "credentials",
  envVars: [],
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

  async connectWithCredentials(_config, fields) {
    const creds: BlueskyCredentials = {
      identifier: (fields.identifier ?? "").trim().replace(/^@/, ""),
      appPassword: (fields.appPassword ?? "").trim(),
      service: normalizeService(fields.service),
    };
    if (!creds.identifier || !creds.appPassword) throw new UserError("Enter your Bluesky handle and an app password.");
    const session = await createSession(creds);
    let profile: any = {};
    try {
      profile = (await request(xrpc(session, "app.bsky.actor.getProfile"), { query: { actor: session.did }, headers: auth(session) })).data;
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
  const res = await request(xrpc(s, "com.atproto.repo.uploadBlob"), {
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
  const serviceAuth = await request(xrpc(s, "com.atproto.server.getServiceAuth"), {
    headers: auth(s),
    query: {
      aud: `did:web:${new URL(s.pds).host}`,
      lxm: "com.atproto.repo.uploadBlob",
      exp: Math.floor(Date.now() / 1000) + 30 * 60,
    },
  });
  ctx.progress(`Uploading video (${(m.size / 1024 / 1024).toFixed(1)} MB) to Bluesky…`);
  const isM4v = m.mime === "video/x-m4v"; // an MP4 container; the video service only knows video/mp4
  const upload = await request("https://video.bsky.app/xrpc/app.bsky.video.uploadVideo", {
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
        const st = (await request("https://video.bsky.app/xrpc/app.bsky.video.getJobStatus", { query: { jobId: job.jobId } })).data.jobStatus;
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
    const creds = (await ctx.credentials()) as BlueskyCredentials;
    ctx.progress("Signing in to Bluesky…");
    const reused = !!creds.appPassword && sessions.has(sessionKey(creds));
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
    const s = await getSession((await ctx.credentials()) as BlueskyCredentials);
    return `Can post as @${s.handle}.`;
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
      return (await request(xrpc(s, "com.atproto.identity.resolveHandle"), { query: { handle } })).data.did ?? null;
    } catch {
      return null;
    }
  });

  ctx.progress("Posting to Bluesky…");
  const res = await publishStep("Bluesky", () =>
    request(xrpc(s, "com.atproto.repo.createRecord"), {
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
