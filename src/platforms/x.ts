import { ApiError, AuthError, request, type RequestOptions } from "../http.js";
import { readRange, type MediaFile } from "../media.js";
import type { Config } from "../config.js";
import type { Connector, Platform, PublishContext } from "./types.js";

const API = "https://api.x.com/2";
const SEGMENT = 4 * 1024 * 1024; // appended segments must be under 5 MB

interface XCredentials {
  accessToken: string;
  refreshToken: string;
}

function tokenHeaders(config: Config): Record<string, string> {
  // Confidential clients authenticate with HTTP Basic; public clients only send client_id.
  if (!config.x.clientSecret) return {};
  const basic = Buffer.from(`${encodeURIComponent(config.x.clientId)}:${encodeURIComponent(config.x.clientSecret)}`).toString("base64");
  return { Authorization: `Basic ${basic}` };
}

export const xConnector: Connector = {
  id: "x",
  name: "X (Twitter)",
  platforms: ["x"],
  kind: "oauth",
  usesPkce: true,
  envVars: ["X_CLIENT_ID", "X_CLIENT_SECRET"],
  developerPortal: "https://developer.x.com/en/portal/dashboard",
  isConfigured: (c) => !!c.x.clientId,

  authorizeUrl(config, { state, redirectUri, codeChallenge }) {
    const u = new URL("https://x.com/i/oauth2/authorize");
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", config.x.clientId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("scope", "tweet.read tweet.write users.read media.write offline.access");
    u.searchParams.set("state", state);
    u.searchParams.set("code_challenge", codeChallenge!);
    u.searchParams.set("code_challenge_method", "S256");
    return u.toString();
  },

  async exchangeCode(config, { code, redirectUri, codeVerifier }) {
    const t = (
      await request(`${API}/oauth2/token`, {
        method: "POST",
        headers: tokenHeaders(config),
        form: {
          code,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
          client_id: config.x.clientId,
        },
      })
    ).data;
    const me = (
      await request(`${API}/users/me`, {
        query: { "user.fields": "profile_image_url" },
        headers: { Authorization: `Bearer ${t.access_token}` },
      })
    ).data.data;
    return [
      {
        platform: "x",
        externalId: me.id,
        name: me.name,
        username: me.username,
        avatarUrl: me.profile_image_url ?? null,
        credentials: { accessToken: t.access_token, refreshToken: t.refresh_token } satisfies XCredentials,
        expiresAt: Date.now() + (t.expires_in ?? 7200) * 1000,
      },
    ];
  },

  async refresh(config, _account, credentials) {
    const c = credentials as XCredentials;
    try {
      const t = (
        await request(`${API}/oauth2/token`, {
          method: "POST",
          headers: tokenHeaders(config),
          form: { grant_type: "refresh_token", refresh_token: c.refreshToken, client_id: config.x.clientId },
        })
      ).data;
      // X rotates refresh tokens: the old one stops working once used.
      return {
        credentials: { accessToken: t.access_token, refreshToken: t.refresh_token ?? c.refreshToken } satisfies XCredentials,
        expiresAt: Date.now() + (t.expires_in ?? 7200) * 1000,
      };
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) throw new AuthError("X rejected the saved login. Reconnect the account.");
      throw err;
    }
  },
};

function xRequest<T = any>(token: string, url: string, opts: RequestOptions = {}) {
  return request<T>(url, { ...opts, headers: { Authorization: `Bearer ${token}`, ...opts.headers } });
}

function mediaCategory(m: MediaFile): string {
  if (m.kind === "video") return "tweet_video";
  return m.mime === "image/gif" ? "tweet_gif" : "tweet_image";
}

async function uploadMedia(ctx: PublishContext, token: string, m: MediaFile, label: string): Promise<string> {
  const init = await xRequest(token, `${API}/media/upload/initialize`, {
    method: "POST",
    json: { media_type: m.mime === "video/x-m4v" ? "video/mp4" : m.mime, total_bytes: m.size, media_category: mediaCategory(m) },
  });
  const id: string = init.data.data.id;

  const segments = Math.ceil(m.size / SEGMENT);
  for (let i = 0; i < segments; i++) {
    ctx.progress(`Uploading ${label} to X (${i + 1}/${segments})…`);
    const start = i * SEGMENT;
    const end = Math.min(start + SEGMENT, m.size) - 1;
    const form = new FormData();
    form.set("segment_index", String(i));
    form.set("media", new Blob([await readRange(m.path, start, end)], { type: "application/octet-stream" }), m.filename);
    await xRequest(token, `${API}/media/upload/${id}/append`, { method: "POST", body: form, timeoutMs: 10 * 60_000 });
  }

  const fin = await xRequest(token, `${API}/media/upload/${id}/finalize`, { method: "POST" });
  // Videos/GIFs are processed asynchronously; X tells us how long to wait between checks.
  let processing = fin.data?.data?.processing_info;
  const deadline = Date.now() + 15 * 60_000;
  while (processing && processing.state !== "succeeded") {
    if (processing.state === "failed") {
      throw new Error(`X couldn't process ${label}: ${processing.error?.message ?? "unknown error"}`);
    }
    if (Date.now() > deadline) throw new ApiError(`Timed out waiting for X to process ${label}`, 0, null, false);
    ctx.progress(`Waiting for X to process ${label}…`);
    await ctx.sleep(Math.max(1, Number(processing.check_after_secs ?? 2)) * 1000);
    const s = await xRequest(token, `${API}/media/upload`, { query: { media_id: id, command: "STATUS" } });
    processing = s.data?.data?.processing_info;
  }
  return id;
}

export const x: Platform = {
  id: "x",
  name: "X",
  connector: "x",
  capabilities: {
    textOnly: true,
    maxTextLength: 280,
    maxImages: 4,
    video: true,
    mixedMedia: false,
    needsPublicMediaUrl: false,
    usesTitle: false,
  },
  options: [{ key: "premium", label: "Account has X Premium (long posts)", type: "checkbox", default: false }],

  validate(input) {
    const errors: string[] = [];
    if (input.media.some((m) => m.mime === "video/webm")) errors.push("X doesn't accept WebM videos; use MP4.");
    if (input.media.filter((m) => m.mime === "image/gif").length > 0 && input.media.length > 1) {
      errors.push("X only allows a GIF on its own.");
    }
    return errors;
  },

  async publish(ctx) {
    const { accessToken: token } = (await ctx.credentials()) as XCredentials;
    const mediaIds: string[] = [];
    for (const [i, m] of ctx.input.media.entries()) {
      const label = ctx.input.media.length > 1 ? `item ${i + 1}` : m.kind === "video" ? "the video" : "the image";
      mediaIds.push(await uploadMedia(ctx, token, m, label));
    }
    ctx.progress("Posting to X…");
    const res = await xRequest(token, `${API}/tweets`, {
      method: "POST",
      json: { text: ctx.input.text, ...(mediaIds.length ? { media: { media_ids: mediaIds } } : {}) },
    });
    const id: string = res.data.data.id;
    const user = ctx.account.username;
    return { remoteId: id, url: user ? `https://x.com/${user}/status/${id}` : `https://x.com/i/web/status/${id}` };
  },
};
