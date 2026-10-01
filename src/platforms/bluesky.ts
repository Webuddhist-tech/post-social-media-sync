import { ApiError, request, UserError } from "../http.js";
import { fileBlob, readRange, type MediaFile } from "../media.js";
import { pollUntil } from "./meta.js";
import type { Connector, Platform, PublishContext } from "./types.js";

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

const MAX_IMAGE_BYTES = 950_000; // Bluesky's limit is 1,000,000 bytes per image

function normalizeService(service: string | undefined): string {
  const s = (service || "https://bsky.social").trim().replace(/\/+$/, "");
  return /^https?:\/\//.test(s) ? s : `https://${s}`;
}

async function createSession(c: BlueskyCredentials): Promise<Session> {
  const res = await request(`${c.service}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    json: { identifier: c.identifier, password: c.appPassword },
  });
  const d = res.data;
  const pds = d.didDoc?.service?.find((s: any) => String(s.id).endsWith("#atproto_pds"))?.serviceEndpoint ?? c.service;
  return { did: d.did, handle: d.handle, accessJwt: d.accessJwt, pds: String(pds).replace(/\/+$/, "") };
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

/** Links, #hashtags and @mentions need explicit "facets" (with UTF-8 byte offsets) to be clickable on Bluesky. */
export async function detectFacets(text: string, resolveHandle: (handle: string) => Promise<string | null>): Promise<Facet[]> {
  const facets: Facet[] = [];
  const add = (start: number, end: number, feature: Record<string, string>) =>
    facets.push({ index: { byteStart: byteOffset(text, start), byteEnd: byteOffset(text, end) }, features: [feature] });

  for (const m of text.matchAll(/https?:\/\/[^\s<>"]+/gi)) {
    const url = m[0].replace(/[.,;:!?)\]'"]+$/, "");
    add(m.index!, m.index! + url.length, { $type: "app.bsky.richtext.facet#link", uri: url });
  }
  for (const m of text.matchAll(/(^|\s)#([\p{L}\p{N}_]*[\p{L}_][\p{L}\p{N}_]*)/gu)) {
    if (m[2].length > 64) continue;
    const start = m.index! + m[1].length;
    add(start, start + 1 + m[2].length, { $type: "app.bsky.richtext.facet#tag", tag: m[2] });
  }
  for (const m of text.matchAll(/(^|[\s(])@([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+)/g)) {
    const handle = m[2].replace(/\.+$/, "");
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
  const img = ok ? m : await ctx.media.jpegVariant(m, { maxBytes: MAX_IMAGE_BYTES, maxDimension: 2000 });
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
  const upload = await request("https://video.bsky.app/xrpc/app.bsky.video.uploadVideo", {
    method: "POST",
    query: { did: s.did, name: `${m.id}${m.file.slice(m.file.lastIndexOf("."))}` },
    headers: { Authorization: `Bearer ${serviceAuth.data.token}`, "Content-Type": m.mime },
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
        if (st.state === "JOB_STATE_FAILED") throw new Error(`Bluesky couldn't process the video: ${st.error ?? st.message ?? "unknown error"}`);
        return st.blob ?? null;
      },
      { intervalMs: 2000, timeoutMs: 20 * 60_000, what: "Bluesky to process the video" },
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
    if (video && video.size > 100 * 1024 * 1024) errors.push("Bluesky videos must be under 100 MB.");
    if (video?.duration && video.duration > 180) errors.push("Bluesky videos can be at most 3 minutes long.");
    return errors;
  },

  async publish(ctx) {
    const creds = (await ctx.credentials()) as BlueskyCredentials;
    ctx.progress("Signing in to Bluesky…");
    const s = await createSession(creds);
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
    const res = await request(xrpc(s, "com.atproto.repo.createRecord"), {
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
    });
    const uri: string = res.data.uri;
    const rkey = uri.split("/").pop();
    return { remoteId: uri, url: `https://bsky.app/profile/${s.handle}/post/${rkey}` };
  },
};
