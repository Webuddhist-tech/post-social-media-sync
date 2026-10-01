/**
 * Meta (Facebook Login) — one login gives access to the user's Facebook Pages and the
 * Instagram professional accounts linked to those Pages.
 */
import type { Config } from "../config.js";
import { ApiError, AuthError, request, UserError, type RequestOptions } from "../http.js";
import type { AccountDraft, Connector } from "./types.js";

export const META_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "business_management",
  "instagram_basic",
  "instagram_content_publish",
];

export function graphUrl(config: Config, path: string, host = "graph.facebook.com"): string {
  return `https://${host}/${config.meta.graphVersion}/${path.replace(/^\//, "")}`;
}

/** Graph API call with Meta's error codes mapped to retry/re-auth semantics. */
export async function graph<T = any>(url: string, opts: RequestOptions = {}): Promise<T> {
  try {
    return (await request<T>(url, opts)).data;
  } catch (err) {
    if (err instanceof ApiError) {
      const e = (err.body as any)?.error;
      const code = Number(e?.code);
      if (code === 190 || code === 102) {
        throw new AuthError(`Meta says the access token is no longer valid (${e?.message ?? "code 190"}). Reconnect the account.`);
      }
      // 1/2 = temporary, 4/17/32/613 = rate limits, 368 = temporarily blocked for policy reasons.
      const transient = e?.is_transient === true || [1, 2, 4, 17, 32, 341, 613].includes(code);
      if (transient && !err.retryable) throw new ApiError(err.message, err.status, err.body, true);
    }
    throw err;
  }
}

/** Polls `check` until it returns a value, or throws after `timeoutMs`. */
export async function pollUntil<T>(
  sleep: (ms: number) => Promise<void>,
  check: () => Promise<T | null>,
  opts: { intervalMs: number; timeoutMs: number; what: string },
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs;
  let interval = opts.intervalMs;
  for (;;) {
    const result = await check();
    if (result !== null) return result;
    if (Date.now() > deadline) {
      throw new ApiError(`Timed out after ${Math.round(opts.timeoutMs / 60000)} min waiting for ${opts.what}`, 0, null, false);
    }
    await sleep(interval);
    interval = Math.min(interval * 1.5, 30_000);
  }
}

export const metaConnector: Connector = {
  id: "meta",
  name: "Facebook & Instagram",
  platforms: ["facebook", "instagram"],
  kind: "oauth",
  envVars: ["META_APP_ID", "META_APP_SECRET"],
  developerPortal: "https://developers.facebook.com/apps",
  isConfigured: (c) => !!(c.meta.appId && c.meta.appSecret),

  authorizeUrl(config, { state, redirectUri }) {
    const u = new URL(`https://www.facebook.com/${config.meta.graphVersion}/dialog/oauth`);
    u.searchParams.set("client_id", config.meta.appId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("state", state);
    u.searchParams.set("response_type", "code");
    // "Facebook Login for Business" apps use a configuration ID instead of a scope list.
    if (config.meta.loginConfigId) u.searchParams.set("config_id", config.meta.loginConfigId);
    else u.searchParams.set("scope", META_SCOPES.join(","));
    return u.toString();
  },

  async exchangeCode(config, { code, redirectUri }) {
    const short = await graph<{ access_token: string }>(graphUrl(config, "oauth/access_token"), {
      query: { client_id: config.meta.appId, client_secret: config.meta.appSecret, redirect_uri: redirectUri, code },
    });
    // Page tokens derived from a long-lived user token don't expire.
    const long = await graph<{ access_token: string }>(graphUrl(config, "oauth/access_token"), {
      query: {
        grant_type: "fb_exchange_token",
        client_id: config.meta.appId,
        client_secret: config.meta.appSecret,
        fb_exchange_token: short.access_token,
      },
    });

    const pages: any[] = [];
    let next: string | null = graphUrl(config, "me/accounts");
    let query: RequestOptions["query"] = {
      fields: "id,name,access_token,picture{url},instagram_business_account{id,username,name,profile_picture_url}",
      limit: 100,
      access_token: long.access_token,
    };
    for (let i = 0; next && i < 10; i++) {
      const res: any = await graph(next, { query });
      pages.push(...(res.data ?? []));
      next = res.paging?.next ?? null;
      query = undefined; // `next` already carries the query
    }

    if (pages.length === 0) {
      throw new UserError(
        "No Facebook Pages were shared with the app. Log in again and make sure you select your Page(s) " +
          "(and the Instagram accounts linked to them) on the permissions screen.",
      );
    }

    const drafts: AccountDraft[] = [];
    for (const page of pages) {
      drafts.push({
        platform: "facebook",
        externalId: page.id,
        name: page.name,
        avatarUrl: page.picture?.data?.url ?? null,
        credentials: { pageAccessToken: page.access_token },
        expiresAt: null,
      });
      const ig = page.instagram_business_account;
      if (ig?.id) {
        drafts.push({
          platform: "instagram",
          externalId: ig.id,
          name: ig.name || ig.username || `Instagram (${page.name})`,
          username: ig.username ?? null,
          avatarUrl: ig.profile_picture_url ?? null,
          credentials: { accessToken: page.access_token },
          meta: { pageId: page.id, pageName: page.name },
          expiresAt: null,
        });
      }
    }
    return drafts;
  },
};
