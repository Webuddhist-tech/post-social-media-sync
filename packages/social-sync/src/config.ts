/** App keys for each platform. Leave a platform out (or its keys empty) to disable it. Bluesky needs no keys. */
export interface PlatformKeys {
  meta?: { appId: string; appSecret: string; graphVersion?: string; loginConfigId?: string | null; extraScopes?: string[] };
  threads?: { appId: string; appSecret: string };
  tiktok?: { clientKey: string; clientSecret: string; scopes?: string };
  linkedin?: { clientId: string; clientSecret: string; version?: string | null; organizations?: boolean };
  google?: { clientId: string; clientSecret: string };
  x?: { clientId: string; clientSecret?: string };
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
}

export function resolvePlatformKeys(keys: PlatformKeys = {}): Pick<Config, "meta" | "threads" | "tiktok" | "linkedin" | "google" | "x"> {
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
  };
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
