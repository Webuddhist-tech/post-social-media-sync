import { ApiError, AuthError, request, uncertainOutcome, UserError, type HttpResponse } from "../http.js";
import { readRange } from "../media.js";
import { withFreshToken } from "./common.js";
import type { Connector, Platform, PublishContext } from "./types.js";

interface GoogleCredentials {
  accessToken: string;
  refreshToken: string;
}

const SCOPES = ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"];
const CHUNK = 32 * 1024 * 1024; // must be a multiple of 256 KiB

export const googleConnector: Connector = {
  id: "google",
  name: "YouTube",
  platforms: ["youtube"],
  kind: "oauth",
  developerPortal: "https://console.cloud.google.com/apis/credentials",
  isConfigured: (c) => !!(c.google.clientId && c.google.clientSecret),

  authorizeUrl(config, { state, redirectUri }) {
    const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    u.searchParams.set("client_id", config.google.clientId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", SCOPES.join(" "));
    u.searchParams.set("access_type", "offline");
    u.searchParams.set("prompt", "consent"); // always return a refresh token
    u.searchParams.set("include_granted_scopes", "true");
    u.searchParams.set("state", state);
    return u.toString();
  },

  async exchangeCode(config, { code, redirectUri }) {
    const t = (
      await request("https://oauth2.googleapis.com/token", {
        method: "POST",
        form: {
          code,
          client_id: config.google.clientId,
          client_secret: config.google.clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        },
      })
    ).data;
    if (!t.refresh_token) {
      throw new UserError("Google didn't return a refresh token. Remove the app's access at myaccount.google.com/permissions and connect again.");
    }
    // Google lets people untick individual permissions on the consent screen.
    const granted = new Set(String(t.scope ?? "").split(" "));
    const full = granted.has("https://www.googleapis.com/auth/youtube");
    if (!full && !SCOPES.every((sc) => granted.has(sc))) {
      throw new UserError("Google didn't grant all YouTube permissions. Connect again and tick both YouTube boxes on the consent screen.");
    }
    const channels = (
      await request("https://www.googleapis.com/youtube/v3/channels", {
        query: { part: "snippet", mine: "true" },
        headers: { Authorization: `Bearer ${t.access_token}` },
      })
    ).data;
    const items: any[] = channels.items ?? [];
    if (items.length === 0) {
      throw new UserError("This Google account has no YouTube channel. Create one at youtube.com first, then connect again.");
    }
    return items.map((ch) => ({
      platform: "youtube" as const,
      externalId: ch.id,
      name: ch.snippet?.title ?? "YouTube channel",
      username: ch.snippet?.customUrl ?? null,
      avatarUrl: ch.snippet?.thumbnails?.default?.url ?? null,
      credentials: { accessToken: t.access_token, refreshToken: t.refresh_token } satisfies GoogleCredentials,
      expiresAt: Date.now() + t.expires_in * 1000,
    }));
  },

  async refresh(config, _account, credentials) {
    const c = credentials as GoogleCredentials;
    try {
      const t = (
        await request("https://oauth2.googleapis.com/token", {
          method: "POST",
          form: {
            client_id: config.google.clientId,
            client_secret: config.google.clientSecret,
            refresh_token: c.refreshToken,
            grant_type: "refresh_token",
          },
        })
      ).data;
      return {
        credentials: { accessToken: t.access_token, refreshToken: t.refresh_token ?? c.refreshToken },
        expiresAt: Date.now() + t.expires_in * 1000,
      };
    } catch (err) {
      if (err instanceof ApiError && (err.body as any)?.error === "invalid_grant") {
        throw new AuthError(
          "Google revoked the YouTube login (this happens after 7 days while the OAuth app is in \"Testing\" mode). Reconnect the account, or publish the OAuth app.",
        );
      }
      throw err;
    }
  },
};

/** YouTube rejects `<` and `>` in titles, descriptions and tags. */
const clean = (s: string) => s.replace(/[<>]/g, "");

export function youtubeTitle(title: string | null, text: string): string {
  const firstLine = text.split("\n").find((l) => clean(l).trim());
  const t = clean(title?.trim() || firstLine || "").replace(/\s+/g, " ").trim() || "Untitled";
  const chars = Array.from(t); // count characters, not UTF-16 units, so emoji aren't cut in half
  return chars.length > 100 ? chars.slice(0, 99).join("").trimEnd() + "…" : t;
}

export function parseTags(raw: unknown): string[] {
  return String(raw ?? "")
    .split(",")
    .map((t) => clean(t).trim().replace(/^#/, ""))
    .filter(Boolean);
}

/** YouTube's 500-character tag budget: commas count, and tags with spaces count their (implicit) quotes. */
export function tagsLength(tags: string[]): number {
  return tags.reduce((n, t) => n + t.length + (/\s/.test(t) ? 2 : 0), 0) + Math.max(0, tags.length - 1);
}

/** Google reports throttling and quota problems as 403s with a reason; make them actionable. */
function googleError(err: unknown): unknown {
  if (!(err instanceof ApiError)) return err;
  const reason = (err.body as any)?.error?.errors?.[0]?.reason;
  if (["rateLimitExceeded", "userRateLimitExceeded", "uploadRateLimitExceeded"].includes(reason)) {
    return new ApiError(err.message, err.status, err.body, true, err);
  }
  if (reason === "quotaExceeded") {
    return new ApiError("The YouTube API quota of your Google Cloud project is used up for today (it resets at midnight Pacific time).", err.status, err.body, false);
  }
  if (reason === "uploadLimitExceeded") {
    return new ApiError("This YouTube channel reached its upload limit for today. Try again tomorrow.", err.status, err.body, false);
  }
  if (reason === "insufficientPermissions") {
    return new AuthError("Google didn't allow uploading to this channel. Reconnect YouTube and allow both permissions.");
  }
  return err;
}

/**
 * Sends the file through a resumable upload session. On a dropped connection it asks the session how much it has
 * and continues from there, so a hiccup never creates a second video.
 */
async function uploadFile(ctx: PublishContext, uploadUrl: string): Promise<any> {
  const video = ctx.input.media[0];
  const token = async (force = false) => ((await ctx.credentials(force ? { force: true } : undefined)) as GoogleCredentials).accessToken;
  const probe = async () =>
    request(uploadUrl, {
      method: "PUT",
      headers: { Authorization: `Bearer ${await token()}`, "Content-Range": `bytes */${video.size}` },
      okStatuses: [308],
    });

  let offset = 0;
  let needProbe = false;
  let failures = 0;
  let stalls = 0;
  let refreshed = false;
  // A resumable upload only becomes a video once YouTube has the last byte. Until a request carrying it has been
  // sent, a failure can't have created anything, so it's safe for the queue to retry with a new session.
  let finalSent = false;
  for (;;) {
    let res: HttpResponse;
    const probing = needProbe || offset >= video.size;
    try {
      if (probing) {
        res = await probe();
      } else {
        const end = Math.min(offset + CHUNK, video.size) - 1;
        ctx.progress(`Uploading to YouTube (${Math.round(((end + 1) / video.size) * 100)}%)…`);
        if (end === video.size - 1) finalSent = true;
        res = await request(uploadUrl, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${await token()}`,
            "Content-Type": video.mime,
            "Content-Range": `bytes ${offset}-${end}/${video.size}`,
          },
          body: await readRange(video.path, offset, end),
          okStatuses: [308],
          timeoutMs: 30 * 60_000,
        });
      }
      needProbe = false;
    } catch (raw) {
      if (raw instanceof AuthError && !refreshed) {
        refreshed = true; // the token expired mid-upload: refresh once and pick up where we left off
        await token(true);
        needProbe = true;
        continue;
      }
      if (probing && raw instanceof ApiError && (raw.status === 404 || raw.status === 410)) {
        throw new ApiError("The YouTube upload session expired before the upload finished.", raw.status, raw.body, true);
      }
      const err = googleError(raw); // e.g. 403 rateLimitExceeded becomes retryable
      if (!(err instanceof ApiError) || !err.retryable) throw err;
      if (++failures > 5) throw finalSent ? uncertainOutcome("YouTube", err) : err;
      const backoff = Math.min(60_000, 5000 * 2 ** (failures - 1));
      await ctx.sleep(Math.min(5 * 60_000, Math.max(backoff, err.retryAfterMs ?? 0)));
      needProbe = true;
      continue;
    }

    if (res.status !== 308) return res.data; // 200/201: the upload is complete and the video exists
    // "Range: bytes=0-N" says what YouTube has stored; no header means nothing yet.
    const range = res.headers.get("range");
    const next = range ? Number(range.split("-")[1]) + 1 : 0;
    finalSent = false; // a 308 means YouTube doesn't have the whole file yet
    if (next > offset) {
      failures = 0; // only real progress earns a fresh error budget
      refreshed = false;
    } else if ((!probing || offset >= video.size) && ++stalls > 3) {
      throw new ApiError("The YouTube upload isn't making progress.", 308, null, true);
    }
    offset = next;
  }
}

export const youtube: Platform = {
  id: "youtube",
  name: "YouTube",
  connector: "google",
  capabilities: {
    textOnly: false,
    maxTextLength: 5000,
    maxImages: 0,
    video: true,
    mixedMedia: false,
    needsPublicMediaUrl: false,
    usesTitle: true,
  },
  options: [
    {
      key: "privacyStatus",
      label: "Visibility",
      type: "select",
      choices: [
        { value: "public", label: "Public" },
        { value: "unlisted", label: "Unlisted" },
        { value: "private", label: "Private" },
      ],
      default: "public",
    },
    {
      key: "categoryId",
      label: "Category",
      type: "select",
      choices: [
        { value: "22", label: "People & Blogs" },
        { value: "1", label: "Film & Animation" },
        { value: "2", label: "Autos & Vehicles" },
        { value: "10", label: "Music" },
        { value: "15", label: "Pets & Animals" },
        { value: "17", label: "Sports" },
        { value: "19", label: "Travel & Events" },
        { value: "20", label: "Gaming" },
        { value: "23", label: "Comedy" },
        { value: "24", label: "Entertainment" },
        { value: "25", label: "News & Politics" },
        { value: "26", label: "Howto & Style" },
        { value: "27", label: "Education" },
        { value: "28", label: "Science & Technology" },
        { value: "29", label: "Nonprofits & Activism" },
      ],
      default: "22",
    },
    { key: "tags", label: "Tags (comma separated)", type: "text", default: "" },
    { key: "madeForKids", label: "Made for kids", type: "checkbox", default: false },
    { key: "notifySubscribers", label: "Notify subscribers", type: "checkbox", default: true },
    { key: "syntheticMedia", label: "Contains realistic altered/AI content", type: "checkbox", default: false },
  ],

  validate(input) {
    const errors: string[] = [];
    if (Buffer.byteLength(clean(input.text)) > 5000) errors.push("YouTube descriptions are limited to 5000 bytes.");
    if (tagsLength(parseTags(input.options.tags)) > 500) errors.push("YouTube tags are limited to 500 characters in total.");
    return errors;
  },

  async publish(ctx) {
    const video = ctx.input.media[0];
    if (!video || video.kind !== "video") throw new UserError("YouTube needs exactly one video.");
    const o = ctx.input.options;
    const tags = parseTags(o.tags);

    ctx.progress("Starting YouTube upload…");
    let start: HttpResponse;
    try {
      start = await withFreshToken(ctx, (c) => c.accessToken, (accessToken) =>
        request("https://www.googleapis.com/upload/youtube/v3/videos", {
          method: "POST",
          query: { uploadType: "resumable", part: "snippet,status", notifySubscribers: o.notifySubscribers !== false },
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json; charset=UTF-8",
            "X-Upload-Content-Length": String(video.size),
            "X-Upload-Content-Type": video.mime,
          },
          json: {
            snippet: {
              title: youtubeTitle(ctx.input.title, ctx.input.text),
              description: clean(ctx.input.text),
              ...(tags.length ? { tags } : {}),
              categoryId: String(o.categoryId ?? "22"),
            },
            status: {
              privacyStatus: ["public", "unlisted", "private"].includes(String(o.privacyStatus)) ? o.privacyStatus : "public",
              selfDeclaredMadeForKids: !!o.madeForKids,
              containsSyntheticMedia: !!o.syntheticMedia,
            },
          },
        }),
      );
    } catch (err) {
      throw googleError(err);
    }
    const uploadUrl = start.headers.get("location");
    if (!uploadUrl) throw new ApiError("YouTube didn't return an upload URL", start.status, start.data, true);

    const result = await uploadFile(ctx, uploadUrl);
    if (!result?.id) throw new ApiError("YouTube upload finished without returning a video ID", 0, result, false);

    const isShort = !!(video.duration && video.duration <= 180 && video.height && video.width && video.height > video.width);
    const status = result.status?.privacyStatus;
    const requested = String(o.privacyStatus ?? "public");
    return {
      remoteId: result.id,
      url: isShort ? `https://www.youtube.com/shorts/${result.id}` : `https://www.youtube.com/watch?v=${result.id}`,
      note:
        status && status !== requested
          ? `YouTube set the video to "${status}". Videos uploaded by unverified API projects are locked to private until the project passes Google's audit.`
          : "YouTube is processing the video; it can take a few minutes to appear.",
    };
  },

  async checkConnection(ctx) {
    const { accessToken } = (await ctx.credentials()) as GoogleCredentials;
    const res = await request("https://www.googleapis.com/youtube/v3/channels", {
      query: { part: "snippet", mine: "true" },
      headers: { Authorization: `Bearer ${accessToken}` },
    }).catch((err) => Promise.reject(googleError(err)));
    const channel = (res.data.items ?? []).find((c: any) => c.id === ctx.account.externalId) ?? res.data.items?.[0];
    if (!channel) throw new AuthError("This Google login no longer has a YouTube channel. Reconnect YouTube.");
    return `Can upload to the channel "${channel.snippet?.title}".`;
  },
};
