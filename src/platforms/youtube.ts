import { ApiError, AuthError, request, UserError } from "../http.js";
import { readRange } from "../media.js";
import type { Connector, Platform } from "./types.js";

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
  envVars: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
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

/** YouTube rejects `<` and `>` in titles and descriptions. */
const clean = (s: string) => s.replace(/[<>]/g, "");

export function youtubeTitle(title: string | null, text: string): string {
  const source = (title?.trim() || text.split("\n").find((l) => l.trim()) || "Untitled").trim();
  const t = clean(source);
  return t.length > 100 ? t.slice(0, 99).trimEnd() + "…" : t;
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
    return errors;
  },

  async publish(ctx) {
    const { accessToken } = (await ctx.credentials()) as GoogleCredentials;
    const video = ctx.input.media[0];
    if (!video || video.kind !== "video") throw new UserError("YouTube needs exactly one video.");
    const o = ctx.input.options;
    const tags = String(o.tags ?? "")
      .split(",")
      .map((t) => t.trim().replace(/^#/, ""))
      .filter(Boolean);

    ctx.progress("Starting YouTube upload…");
    const start = await request("https://www.googleapis.com/upload/youtube/v3/videos", {
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
    });
    const uploadUrl = start.headers.get("location");
    if (!uploadUrl) throw new ApiError("YouTube didn't return an upload URL", start.status, start.data, true);

    // Resumable upload in chunks; YouTube answers 308 until the last chunk.
    let offset = 0;
    let stalls = 0;
    let result: any = null;
    while (offset < video.size) {
      const end = Math.min(offset + CHUNK, video.size) - 1;
      ctx.progress(`Uploading to YouTube (${Math.round((end + 1) / video.size * 100)}%)…`);
      const res = await request(uploadUrl, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": video.mime,
          "Content-Range": `bytes ${offset}-${end}/${video.size}`,
        },
        body: await readRange(video.path, offset, end),
        okStatuses: [308],
        timeoutMs: 30 * 60_000,
      });
      if (res.status === 308) {
        // "Range: bytes=0-N" says what YouTube has stored; no header means nothing yet.
        const range = res.headers.get("range");
        const next = range ? Number(range.split("-")[1]) + 1 : 0;
        if (next <= offset && ++stalls > 3) throw new ApiError("YouTube upload isn't making progress", 308, null, true);
        offset = next;
      } else {
        result = res.data;
        break;
      }
    }
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
};
