import { UserError } from "../http.js";
import type { MediaFile } from "../media.js";
import { graph, pollUntil } from "./meta.js";
import type { Connector, Platform, PublishContext } from "./types.js";

const API = "https://graph.threads.net/v1.0";

interface ThreadsCredentials {
  accessToken: string;
}

export const threadsConnector: Connector = {
  id: "threads",
  name: "Threads",
  platforms: ["threads"],
  kind: "oauth",
  envVars: ["THREADS_APP_ID", "THREADS_APP_SECRET"],
  developerPortal: "https://developers.facebook.com/apps",
  isConfigured: (c) => !!(c.threads.appId && c.threads.appSecret),

  authorizeUrl(config, { state, redirectUri }) {
    const u = new URL("https://threads.net/oauth/authorize");
    u.searchParams.set("client_id", config.threads.appId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("scope", "threads_basic,threads_content_publish");
    u.searchParams.set("response_type", "code");
    u.searchParams.set("state", state);
    return u.toString();
  },

  async exchangeCode(config, { code, redirectUri }) {
    const short = await graph<{ access_token: string; user_id: string }>("https://graph.threads.net/oauth/access_token", {
      method: "POST",
      form: {
        client_id: config.threads.appId,
        client_secret: config.threads.appSecret,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        code: code.replace(/#_$/, ""),
      },
    });
    const long = await graph<{ access_token: string; expires_in: number }>("https://graph.threads.net/access_token", {
      query: { grant_type: "th_exchange_token", client_secret: config.threads.appSecret, access_token: short.access_token },
    });
    const me = await graph(`${API}/me`, {
      query: { fields: "id,username,name,threads_profile_picture_url", access_token: long.access_token },
    });
    return [
      {
        platform: "threads",
        externalId: String(me.id ?? short.user_id),
        name: me.name || me.username,
        username: me.username ?? null,
        avatarUrl: me.threads_profile_picture_url ?? null,
        credentials: { accessToken: long.access_token },
        expiresAt: Date.now() + (long.expires_in ?? 60 * 86400) * 1000,
      },
    ];
  },

  async refresh(_config, _account, credentials) {
    // Long-lived Threads tokens last 60 days and can be refreshed while still valid.
    const res = await graph<{ access_token: string; expires_in: number }>("https://graph.threads.net/refresh_access_token", {
      query: { grant_type: "th_refresh_token", access_token: credentials.accessToken },
    });
    return { credentials: { accessToken: res.access_token }, expiresAt: Date.now() + res.expires_in * 1000 };
  },
};

async function waitForContainer(ctx: PublishContext, id: string, token: string): Promise<void> {
  await pollUntil(
    ctx.sleep,
    async () => {
      const res = await graph(`${API}/${id}`, { query: { fields: "status,error_message", access_token: token } });
      if (res.status === "FINISHED" || res.status === "PUBLISHED") return true;
      if (res.status === "ERROR" || res.status === "EXPIRED") {
        throw new Error(`Threads couldn't process the media: ${res.error_message ?? res.status}`);
      }
      return null;
    },
    { intervalMs: 3000, timeoutMs: 15 * 60_000, what: "Threads to process the media" },
  );
}

async function mediaFields(ctx: PublishContext, m: MediaFile): Promise<Record<string, string>> {
  if (m.kind === "video") return { media_type: "VIDEO", video_url: ctx.media.publicUrl(m.file) };
  const image = m.mime === "image/png" ? m : await ctx.media.jpegVariant(m, { maxBytes: 8 * 1024 * 1024 });
  return { media_type: "IMAGE", image_url: ctx.media.publicUrl(image.file) };
}

export const threads: Platform = {
  id: "threads",
  name: "Threads",
  connector: "threads",
  capabilities: {
    textOnly: true,
    maxTextLength: 500,
    maxImages: 20,
    video: true,
    mixedMedia: true,
    maxMediaItems: 20,
    needsPublicMediaUrl: "all",
    usesTitle: false,
  },
  options: [],

  async publish(ctx) {
    const { accessToken: token } = (await ctx.credentials()) as ThreadsCredentials;
    const userId = ctx.account.externalId;
    const { text, media } = ctx.input;
    const create = (fields: Record<string, string>) =>
      graph<{ id: string }>(`${API}/${userId}/threads`, { method: "POST", form: { ...fields, access_token: token } });

    let containerId: string;
    if (media.length === 0) {
      if (!text.trim()) throw new UserError("Threads posts need text or media.");
      containerId = (await create({ media_type: "TEXT", text })).id;
    } else if (media.length === 1) {
      ctx.progress("Sending media to Threads…");
      containerId = (await create({ ...(await mediaFields(ctx, media[0])), text })).id;
    } else {
      const children: string[] = [];
      for (const [i, m] of media.entries()) {
        ctx.progress(`Preparing carousel item ${i + 1} of ${media.length}…`);
        const id = (await create({ ...(await mediaFields(ctx, m)), is_carousel_item: "true" })).id;
        children.push(id);
      }
      for (const id of children) await waitForContainer(ctx, id, token);
      containerId = (await create({ media_type: "CAROUSEL", children: children.join(","), text })).id;
    }

    ctx.progress("Waiting for Threads to process the post…");
    await waitForContainer(ctx, containerId, token);

    ctx.progress("Publishing on Threads…");
    const published = await graph<{ id: string }>(`${API}/${userId}/threads_publish`, {
      method: "POST",
      form: { creation_id: containerId, access_token: token },
    });
    let url: string | null = null;
    try {
      url = (await graph(`${API}/${published.id}`, { query: { fields: "permalink", access_token: token } })).permalink ?? null;
    } catch {
      // nice-to-have
    }
    return { remoteId: published.id, url };
  },
};
