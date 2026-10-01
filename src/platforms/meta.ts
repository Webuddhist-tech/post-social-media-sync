/**
 * Meta (Facebook Login) — one login gives access to the user's Facebook Pages and the
 * Instagram professional accounts linked to those Pages.
 */
import type { Config } from "../config.js";
import { ApiError, AuthError, isUnknownOutcome, request, uncertainOutcome, UserError, type RequestOptions } from "../http.js";
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

/**
 * How Meta's temporary errors should be treated:
 * - "throttle": a rate limit or posting-speed block. Meta refused, nothing happened, retry later.
 * - "unknown": a transient server problem (codes 1/2, is_transient). Meta may or may not have acted.
 */
export function metaErrorKind(e: any): "throttle" | "unknown" | null {
  const code = Number(e?.code);
  // 4/17/32/341/613 = app/user rate limits, 80000-80014 = Business Use Case (per Page/IG account) rate limits,
  // 368/1390008 = "posting too fast" block.
  if ([4, 17, 32, 341, 613].includes(code) || (code >= 80000 && code <= 80014)) return "throttle";
  if (code === 368 && Number(e?.error_subcode) === 1390008) return "throttle";
  if (code === 1 || code === 2 || e?.is_transient === true) return "unknown";
  return null;
}

/** Graph API call with Meta's error codes mapped to retry/re-auth semantics. */
export async function graph<T = any>(url: string, opts: RequestOptions = {}, context: { permissionHint?: string } = {}): Promise<T> {
  try {
    return (await request<T>(url, opts)).data;
  } catch (err) {
    if (err instanceof ApiError) {
      const e = (err.body as any)?.error;
      const code = Number(e?.code);
      if (code === 190 || code === 102) {
        throw new AuthError(`Meta says the access token is no longer valid (${e?.message ?? "code 190"}). Reconnect the account.`);
      }
      const kind = metaErrorKind(e);
      // Unknown-outcome errors are reported like a 5xx, whatever HTTP status Meta used, so publishing steps
      // treat them as "may have happened" instead of retrying blindly.
      if (kind === "unknown") throw new ApiError(err.message, err.status >= 500 ? err.status : 503, err.body, true);
      if (kind === "throttle" && !err.retryable) throw new ApiError(err.message, err.status, err.body, true);
      // (#10) / (#200-299) / "(#100) No permission to publish the video": the app or the person lacks a permission.
      const permission = code === 10 || (code >= 200 && code <= 299) || (code === 100 && /no permission to publish/i.test(e?.message ?? ""));
      if (context.permissionHint && permission) throw new UserError(`${err.message}. ${context.permissionHint}`);
    }
    throw err;
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
    else u.searchParams.set("scope", [...new Set([...META_SCOPES, ...config.meta.extraScopes])].join(","));
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

    // People can untick permissions in the login dialog; find out what was actually granted.
    const granted = new Set<string>();
    try {
      const perms = await graph(graphUrl(config, "me/permissions"), { query: { access_token: long.access_token } });
      for (const p of perms.data ?? []) if (p.status === "granted") granted.add(p.permission);
    } catch {
      // If we can't tell, assume everything was granted and let publishing report problems.
      META_SCOPES.forEach((p) => granted.add(p));
    }
    const canFacebook = ["pages_show_list", "pages_manage_posts"].every((p) => granted.has(p));
    const canInstagram = ["instagram_basic", "instagram_content_publish"].every((p) => granted.has(p));

    const pages: any[] = [];
    let next: string | null = graphUrl(config, "me/accounts");
    let query: RequestOptions["query"] = {
      fields: "id,name,access_token,tasks,picture{url},instagram_business_account{id,username,name,profile_picture_url}",
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
    const skipped: string[] = [];
    for (const page of pages) {
      // Pages listed through a Business the person has no role on come back without a token.
      if (!page.access_token) {
        skipped.push(`${page.name} (no access token, ask for a role on the Page)`);
        continue;
      }
      const tasks: string[] | undefined = page.tasks;
      if (canFacebook && (!tasks || tasks.includes("CREATE_CONTENT"))) {
        drafts.push({
          platform: "facebook",
          externalId: page.id,
          name: page.name,
          avatarUrl: page.picture?.data?.url ?? null,
          credentials: { pageAccessToken: page.access_token },
          expiresAt: null,
        });
      } else if (canFacebook) {
        skipped.push(`${page.name} (your role on this Page can't create posts)`);
      }
      const ig = page.instagram_business_account;
      if (ig?.id && canInstagram) {
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
    if (drafts.length === 0) {
      const missing = [...META_SCOPES].filter((p) => !granted.has(p));
      throw new UserError(
        "None of your Pages can be posted to. " +
          (missing.length ? `These permissions were not granted: ${missing.join(", ")}. Connect again and allow them. ` : "") +
          (skipped.length ? `Skipped: ${skipped.join("; ")}.` : ""),
      );
    }
    return drafts;
  },
};

/**
 * Publishes a Meta container (Instagram media / Threads post) without ever publishing twice.
 * If the publish request's outcome is unknown, re-reads the container a few times: PUBLISHED means it went live;
 * a container that stays FINISHED was not published, so we publish the *same* container again (Meta refuses to
 * publish a container twice, which makes this safe). Anything else is reported as "check before retrying".
 */
export async function publishContainerOnce(opts: {
  platformName: string;
  sleep: (ms: number) => Promise<void>;
  publish: () => Promise<{ id: string }>;
  status: () => Promise<string | null>;
}): Promise<{ id: string } | { publishedContainer: true }> {
  let firstError: ApiError | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await opts.publish();
    } catch (err) {
      // A clear refusal on the first try (bad media, permissions, rate limit) is handled by the normal rules.
      if (attempt === 1 && !isUnknownOutcome(err)) throw err;
      if (err instanceof ApiError) firstError ??= err;
      let status: string | null = null;
      for (let check = 1; check <= 3; check++) {
        await opts.sleep(check * 10_000);
        status = await opts.status().catch(() => null);
        if (status === "PUBLISHED") return { publishedContainer: true };
        if (status !== "FINISHED") break;
      }
      // Still FINISHED after ~1 minute means it wasn't published: try the same container once more.
      if (attempt === 1 && status === "FINISHED") continue;
      if (firstError) throw uncertainOutcome(opts.platformName, firstError);
      throw err;
    }
  }
  throw new Error("unreachable");
}
