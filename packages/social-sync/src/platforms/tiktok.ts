import { ApiError, AuthError, isUnknownOutcome, request, UserError, type RequestOptions } from "../http.js";
import { readRange, type MediaFile } from "../media.js";
import { pollUntil, withFreshToken } from "./common.js";
import type { Connector, Platform, PublishContext } from "./types.js";

const API = "https://open.tiktokapis.com/v2";
const MB = 1024 * 1024;

interface TikTokCredentials {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: number;
  openId: string;
}

const HINTS: Record<string, string> = {
  unaudited_client_can_only_post_to_private_accounts:
    "Your TikTok app hasn't passed TikTok's audit yet. Until it does, set your TikTok account to Private in the TikTok app and post with privacy \"Only me\" (or use \"Send to TikTok inbox\").",
  privacy_level_option_mismatch: "That privacy level isn't available for this TikTok account.",
  spam_risk_too_many_posts: "TikTok's daily posting limit for this account was reached. Try again tomorrow.",
  spam_risk_user_banned_from_posting: "TikTok has blocked this account from posting via the API.",
  reached_active_user_cap: "Your TikTok app reached its daily active-user quota.",
  url_ownership_unverified: "TikTok requires domain verification for PULL_FROM_URL uploads.",
};

/** TikTok returns `{ data, error: { code, message } }`; anything but code "ok" is a failure. */
async function tiktokCall(url: string, token: string, opts: RequestOptions = {}): Promise<{ data: any; text: string }> {
  let res;
  try {
    res = await request(url, {
      ...opts,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8", ...opts.headers },
    });
  } catch (err) {
    if (err instanceof ApiError) {
      const code = (err.body as any)?.error?.code;
      if (code === "access_token_invalid" || code === "scope_not_authorized") {
        throw new AuthError(`TikTok rejected the token (${code}). Reconnect the account.`);
      }
      if (code && HINTS[code]) throw new ApiError(`${HINTS[code]} (${code})`, err.status, err.body, err.retryable, err);
    }
    throw err;
  }
  const error = res.data?.error;
  if (error?.code === "access_token_invalid") throw new AuthError("TikTok rejected the token (access_token_invalid). Reconnect the account.");
  if (error && error.code && error.code !== "ok") {
    const hint = HINTS[error.code];
    throw new ApiError(`${hint ?? error.message ?? "TikTok error"} (${error.code})`, res.status, res.data, error.code === "rate_limit_exceeded");
  }
  return { data: res.data?.data, text: res.text };
}

async function tiktok<T = any>(url: string, token: string, opts: RequestOptions = {}): Promise<T> {
  return (await tiktokCall(url, token, opts)).data as T;
}

/** TikTok post ids are 64-bit integers, which JSON.parse rounds; read the digits from the raw body instead. */
export function publicPostId(rawBody: string): string | null {
  return rawBody.match(/"publicaly_available_post_id"\s*:\s*\[\s*"?(\d+)/)?.[1] ?? null;
}

async function tokenRequest(form: Record<string, string>) {
  let res;
  try {
    res = await request("https://open.tiktokapis.com/v2/oauth/token/", { method: "POST", form });
  } catch (err) {
    if (err instanceof ApiError && (err.body as any)?.error === "invalid_grant") throw revoked();
    throw err;
  }
  const d = res.data;
  if (d?.error === "invalid_grant") throw revoked();
  if (!d?.access_token) {
    throw new ApiError(`TikTok token request failed: ${d?.error_description ?? d?.error ?? "unknown error"}`, res.status, d, false);
  }
  return d as {
    access_token: string;
    expires_in: number;
    open_id: string;
    refresh_token: string;
    refresh_expires_in: number;
    scope: string;
  };
}

const revoked = () => new AuthError("The TikTok login was revoked or has expired. Reconnect the account.");

export const tiktokConnector: Connector = {
  id: "tiktok",
  name: "TikTok",
  platforms: ["tiktok"],
  kind: "oauth",
  developerPortal: "https://developers.tiktok.com/apps",
  isConfigured: (c) => !!(c.tiktok.clientKey && c.tiktok.clientSecret),

  authorizeUrl(config, { state, redirectUri }) {
    const u = new URL("https://www.tiktok.com/v2/auth/authorize/");
    u.searchParams.set("client_key", config.tiktok.clientKey);
    u.searchParams.set("scope", config.tiktok.scopes);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("state", state);
    return u.toString();
  },

  async exchangeCode(config, { code, redirectUri }) {
    const t = await tokenRequest({
      client_key: config.tiktok.clientKey,
      client_secret: config.tiktok.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    });
    const info = await tiktok(`${API}/user/info/`, t.access_token, {
      query: { fields: "open_id,avatar_url,display_name" },
      headers: { "Content-Type": "application/json" },
    });
    const user = info?.user ?? {};
    let username: string | null = null;
    if (t.scope?.includes("video.publish")) {
      try {
        username = (await tiktok(`${API}/post/publish/creator_info/query/`, t.access_token, { method: "POST", json: {} }))
          ?.creator_username ?? null;
      } catch {
        // optional
      }
    }
    return [
      {
        platform: "tiktok",
        externalId: t.open_id,
        name: user.display_name || username || "TikTok account",
        username,
        avatarUrl: user.avatar_url ?? null,
        credentials: {
          accessToken: t.access_token,
          refreshToken: t.refresh_token,
          refreshExpiresAt: Date.now() + t.refresh_expires_in * 1000,
          openId: t.open_id,
        } satisfies TikTokCredentials,
        meta: { scopes: t.scope },
        expiresAt: Date.now() + t.expires_in * 1000,
      },
    ];
  },

  async refresh(config, _account, credentials) {
    const c = credentials as TikTokCredentials;
    if (c.refreshExpiresAt && c.refreshExpiresAt < Date.now()) {
      throw new AuthError("The TikTok login expired (refresh token is older than a year). Reconnect the account.");
    }
    const t = await tokenRequest({
      client_key: config.tiktok.clientKey,
      client_secret: config.tiktok.clientSecret,
      grant_type: "refresh_token",
      refresh_token: c.refreshToken,
    });
    return {
      credentials: {
        accessToken: t.access_token,
        refreshToken: t.refresh_token,
        refreshExpiresAt: Date.now() + t.refresh_expires_in * 1000,
        openId: t.open_id ?? c.openId,
      } satisfies TikTokCredentials,
      expiresAt: Date.now() + t.expires_in * 1000,
    };
  },
};

/**
 * TikTok chunk rules: chunks of 5–64 MB uploaded in order, the last chunk absorbs the remainder (≤128 MB),
 * files under 64 MB may go in a single chunk. total_chunk_count = floor(size / chunk_size).
 */
export function tiktokChunks(size: number): { chunkSize: number; count: number; ranges: Array<[number, number]> } {
  const chunkSize = size <= 64 * MB ? size : 16 * MB;
  const count = Math.max(1, Math.floor(size / chunkSize));
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) {
    const start = i * chunkSize;
    const end = i === count - 1 ? size - 1 : start + chunkSize - 1;
    ranges.push([start, end]);
  }
  return { chunkSize, count, ranges };
}

/**
 * Uploads the chunks in order, retrying a chunk in place on temporary errors. Returns "unknown" if the final
 * chunk's response was lost (TikTok may have the whole video and publish it); any other failure is thrown and is
 * safe to retry from scratch, because TikTok never publishes an incomplete upload.
 */
async function uploadChunks(ctx: PublishContext, uploadUrl: string, video: MediaFile): Promise<"done" | "unknown"> {
  const { ranges } = tiktokChunks(video.size);
  const mime = video.mime === "video/x-m4v" ? "video/mp4" : video.mime;
  for (const [i, [start, end]] of ranges.entries()) {
    ctx.progress(`Uploading to TikTok (${i + 1}/${ranges.length})…`);
    const chunk = await readRange(video.path, start, end);
    for (let attempt = 1; ; attempt++) {
      try {
        await request(uploadUrl, {
          method: "PUT",
          headers: {
            "Content-Type": mime,
            "Content-Length": String(chunk.length),
            "Content-Range": `bytes ${start}-${end}/${video.size}`,
          },
          body: chunk,
          timeoutMs: 30 * 60_000,
        });
        break;
      } catch (err) {
        if (!(err instanceof ApiError) || !err.retryable) throw err;
        if (attempt < 3) {
          await ctx.sleep(Math.max(attempt * 5000, err.retryAfterMs ?? 0));
          continue;
        }
        if (i === ranges.length - 1 && isUnknownOutcome(err)) return "unknown";
        throw err;
      }
    }
  }
  return "done";
}

export const tiktokPlatform: Platform = {
  id: "tiktok",
  name: "TikTok",
  connector: "tiktok",
  capabilities: {
    textOnly: false,
    maxTextLength: 2200,
    maxImages: 0,
    video: true,
    mixedMedia: false,
    needsPublicMediaUrl: false,
    usesTitle: false,
  },
  options: [
    {
      key: "mode",
      label: "How to post",
      type: "select",
      choices: [
        { value: "direct", label: "Publish directly" },
        { value: "inbox", label: "Send to TikTok inbox (finish in the app)" },
      ],
      default: "direct",
    },
    {
      key: "privacyLevel",
      label: "Who can view",
      type: "select",
      choices: [
        { value: "PUBLIC_TO_EVERYONE", label: "Everyone" },
        { value: "MUTUAL_FOLLOW_FRIENDS", label: "Friends" },
        { value: "FOLLOWER_OF_CREATOR", label: "Followers" },
        { value: "SELF_ONLY", label: "Only me" },
      ],
      // No default (and not remembered) on purpose: TikTok requires creators to choose each time.
      remember: false,
      help: "Until TikTok audits your app: use \"Only me\" and set your TikTok account to Private (max. 5 accounts per day).",
    },
    { key: "allowComments", label: "Allow comments", type: "checkbox", default: false, remember: false },
    { key: "allowDuet", label: "Allow Duet", type: "checkbox", default: false, remember: false },
    { key: "allowStitch", label: "Allow Stitch", type: "checkbox", default: false, remember: false },
    { key: "brandOrganic", label: "Promotes my own brand", type: "checkbox", default: false, remember: false },
    { key: "brandContent", label: "Paid partnership / branded content", type: "checkbox", default: false, remember: false },
    { key: "aiGenerated", label: "AI-generated content", type: "checkbox", default: false, remember: false },
  ],

  validate(input) {
    const errors: string[] = [];
    if (input.options.mode !== "inbox" && !input.options.privacyLevel) errors.push("Choose who can view this TikTok post.");
    if (input.options.brandContent && input.options.privacyLevel === "SELF_ONLY") {
      errors.push("TikTok doesn't allow branded content to be posted as \"Only me\".");
    }
    return errors;
  },

  async publish(ctx) {
    const { accessToken: token } = (await ctx.credentials()) as TikTokCredentials;
    const video = ctx.input.media[0];
    if (!video || video.kind !== "video") throw new UserError("TikTok posts need exactly one video.");
    const opts = ctx.input.options;
    const mode = opts.mode === "inbox" ? "inbox" : "direct";
    const { chunkSize, count } = tiktokChunks(video.size);
    const sourceInfo = { source: "FILE_UPLOAD", video_size: video.size, chunk_size: chunkSize, total_chunk_count: count };

    let username = ctx.account.username;
    let init: { publish_id: string; upload_url: string };
    if (mode === "direct") {
      ctx.progress("Checking TikTok account settings…");
      const info = await tiktok(`${API}/post/publish/creator_info/query/`, token, { method: "POST", json: {} });
      username = info.creator_username ?? username;
      if (!opts.privacyLevel) throw new UserError("Choose who can view this TikTok post.");
      const privacy = String(opts.privacyLevel);
      const allowed: string[] = info.privacy_level_options ?? [];
      if (allowed.length && !allowed.includes(privacy)) {
        throw new UserError(`This TikTok account can't post with privacy "${privacy}". Allowed: ${allowed.join(", ")}.`);
      }
      if (video.duration && info.max_video_post_duration_sec && video.duration > info.max_video_post_duration_sec) {
        throw new UserError(
          `This TikTok account can post videos up to ${info.max_video_post_duration_sec}s; this one is ${Math.round(video.duration)}s.`,
        );
      }
      init = await tiktok(`${API}/post/publish/video/init/`, token, {
        method: "POST",
        json: {
          post_info: {
            title: ctx.input.text,
            privacy_level: privacy,
            // Interactions are off unless the creator turned them on (and their TikTok settings allow them).
            disable_comment: opts.allowComments !== true || !!info.comment_disabled,
            disable_duet: opts.allowDuet !== true || !!info.duet_disabled,
            disable_stitch: opts.allowStitch !== true || !!info.stitch_disabled,
            brand_organic_toggle: !!opts.brandOrganic,
            brand_content_toggle: !!opts.brandContent,
            is_aigc: !!opts.aiGenerated,
          },
          source_info: sourceInfo,
        },
      });
    } else {
      init = await tiktok(`${API}/post/publish/inbox/video/init/`, token, { method: "POST", json: { source_info: sourceInfo } });
    }

    // Until the last chunk is in, failures are safe to retry from scratch (handled by the worker).
    const upload = await uploadChunks(ctx, init.upload_url, video);

    // From here on TikTok has (or may have) the whole video and publishes it by itself. Starting over would
    // post it twice, so temporary errors are ridden out and anything else is reported as "check TikTok".
    let final: { status: any; postId: string | null };
    try {
      ctx.progress("Waiting for TikTok to process the video…");
      final = await pollUntil(
        ctx.sleep,
        async () => {
          const { data: s, text } = await withFreshToken(ctx, (c: TikTokCredentials) => c.accessToken, (t) =>
            tiktokCall(`${API}/post/publish/status/fetch/`, t, { method: "POST", json: { publish_id: init.publish_id } }),
          );
          if (s.status === "FAILED") throw new UserError(`TikTok rejected the video: ${s.fail_reason ?? "unknown reason"}`);
          if (s.status === "PUBLISH_COMPLETE" || (mode === "inbox" && s.status === "SEND_TO_USER_INBOX")) {
            return { status: s, postId: publicPostId(text) };
          }
          return null;
        },
        { intervalMs: 5000, maxIntervalMs: 30_000, timeoutMs: 30 * 60_000, what: "TikTok to process the video", tolerateTransientErrors: true },
      );
    } catch (err) {
      if (err instanceof UserError) throw err; // TikTok explicitly rejected it: nothing was posted
      const why = err instanceof Error ? err.message : String(err);
      const lost = upload === "unknown" ? " (the upload's last response was lost)" : "";
      throw new ApiError(
        `Couldn't confirm the TikTok post${lost}: ${why}. TikTok may still publish it, so check TikTok before retrying.`,
        err instanceof ApiError ? err.status : 0,
        err instanceof ApiError ? err.body : null,
        false,
      );
    }

    if (mode === "inbox") {
      return {
        remoteId: init.publish_id,
        url: null,
        note: "Sent to your TikTok inbox. Open the TikTok app and tap the notification to finish posting.",
      };
    }
    const postId = final.postId;
    const profile = username ? `https://www.tiktok.com/@${username}` : null;
    return {
      remoteId: postId ?? init.publish_id,
      url: postId && profile ? `${profile}/video/${postId}` : profile,
      note: postId ? null : "Posted. TikTok doesn't return a public link for private posts or while moderation is in progress.",
    };
  },

  async checkConnection(ctx) {
    const { accessToken: token } = (await ctx.credentials()) as TikTokCredentials;
    const scopes = String(ctx.account.meta.scopes ?? "");
    if (!scopes.includes("video.publish")) {
      const info = await tiktok(`${API}/user/info/`, token, { query: { fields: "open_id,display_name" } });
      return `Connected as ${info?.user?.display_name ?? "TikTok user"} (can send videos to the TikTok inbox only).`;
    }
    const info = await tiktok(`${API}/post/publish/creator_info/query/`, token, { method: "POST", json: {} });
    const labels: Record<string, string> = {
      PUBLIC_TO_EVERYONE: "Everyone",
      MUTUAL_FOLLOW_FRIENDS: "Friends",
      FOLLOWER_OF_CREATOR: "Followers",
      SELF_ONLY: "Only me",
    };
    const options = (info.privacy_level_options ?? []).map((p: string) => labels[p] ?? p).join(", ");
    return `Can post as @${info.creator_username}. Privacy choices: ${options}. Videos up to ${info.max_video_post_duration_sec}s.`;
  },
};
