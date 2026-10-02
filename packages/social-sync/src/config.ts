/** App keys for each platform. Leave a platform out (or its keys empty) to disable it. Bluesky needs no keys. */
export interface PlatformKeys {
  meta?: { appId: string; appSecret: string; graphVersion?: string; loginConfigId?: string | null; extraScopes?: string[] };
  threads?: { appId: string; appSecret: string };
  tiktok?: { clientKey: string; clientSecret: string; scopes?: string };
  linkedin?: { clientId: string; clientSecret: string; version?: string | null; organizations?: boolean };
  google?: { clientId: string; clientSecret: string };
  x?: { clientId: string; clientSecret?: string };
  /**
   * Servers users may sign in to (origins, e.g. "https://bsky.social"; default: only that one). Use http:// only for a
   * server you run on a private network.
   */
  bluesky?: { servers?: string[] };
}

/** Resolved settings the platform integrations read (internal). */
export interface Config {
  /** Absolute URL where the HTTP handler is mounted. OAuth callbacks and public media URLs live under it. */
  publicBaseUrl: string;
  mediaDir: string;
  maxUploadBytes: number;
  workerConcurrency: number;
  maxAttempts: number;
  meta: { appId: string; appSecret: string; graphVersion: string; loginConfigId: string | null; extraScopes: string[] };
  threads: { appId: string; appSecret: string };
  tiktok: { clientKey: string; clientSecret: string; scopes: string };
  linkedin: { clientId: string; clientSecret: string; version: string | null; organizations: boolean };
  google: { clientId: string; clientSecret: string };
  x: { clientId: string; clientSecret: string };
  /** Allowed Bluesky sign-in servers, as origins. Never empty. */
  bluesky: { servers: string[] };
}

export const DEFAULT_BLUESKY_SERVERS = ["https://bsky.social"];

export function resolvePlatformKeys(
  keys: PlatformKeys = {},
): Pick<Config, "meta" | "threads" | "tiktok" | "linkedin" | "google" | "x" | "bluesky"> {
  return {
    meta: {
      appId: keys.meta?.appId ?? "",
      appSecret: keys.meta?.appSecret ?? "",
      graphVersion: keys.meta?.graphVersion || "v26.0",
      loginConfigId: keys.meta?.loginConfigId || null,
      extraScopes: keys.meta?.extraScopes ?? [],
    },
    threads: { appId: keys.threads?.appId ?? "", appSecret: keys.threads?.appSecret ?? "" },
    tiktok: {
      clientKey: keys.tiktok?.clientKey ?? "",
      clientSecret: keys.tiktok?.clientSecret ?? "",
      scopes: keys.tiktok?.scopes || "user.info.basic,video.publish,video.upload",
    },
    linkedin: {
      clientId: keys.linkedin?.clientId ?? "",
      clientSecret: keys.linkedin?.clientSecret ?? "",
      version: keys.linkedin?.version || null,
      organizations: !!keys.linkedin?.organizations,
    },
    google: { clientId: keys.google?.clientId ?? "", clientSecret: keys.google?.clientSecret ?? "" },
    x: { clientId: keys.x?.clientId ?? "", clientSecret: keys.x?.clientSecret ?? "" },
    bluesky: { servers: blueskyServers(keys.bluesky?.servers) },
  };
}

function blueskyServers(servers: string[] = []): string[] {
  const list = servers.map((s) => String(s).trim()).filter(Boolean);
  if (!list.length) return [...DEFAULT_BLUESKY_SERVERS];
  const origins = list.map((s) => {
    const origin = serverOrigin(s);
    if (!origin) throw new Error(`PostSync: platforms.bluesky.servers must be server addresses like "https://bsky.social", got "${s}".`);
    return origin;
  });
  return [...new Set(origins)];
}

/**
 * The origin ("https://host[:port]") of a bare http(s) server address, or null if it has anything else: credentials,
 * a path, a query or a fragment. Without a scheme, https:// is assumed.
 */
export function serverOrigin(address: string): string | null {
  const s = address.trim().replace(/\/+$/, "");
  if (!s || /[\s?#\\]/.test(s)) return null;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password || u.pathname !== "/") return null;
  return u.origin;
}

/** True when the host is obviously not reachable from the public internet (platform servers can't download from it). */
export function isPrivateBaseUrl(baseUrl: string): boolean {
  const host = new URL(baseUrl).hostname;
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host === "[::1]" || host === "::1") return true;
  const m = host.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 0;
}
