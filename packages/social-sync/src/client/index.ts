/**
 * Browser (and Node) client for the Post Sync HTTP API. Framework-free and dependency-free: use it from React, Vue,
 * Svelte, plain JS, React Native or a server.
 *
 * ```ts
 * import { createPostSyncClient } from "post-social-media-sync/client";
 * const social = createPostSyncClient({ baseUrl: "/social" });
 * const { accounts } = await social.accounts.list();
 * ```
 */
import type {
  CheckResult,
  ConnectorId,
  Description,
  PostPage,
  PostRequest,
  PublicAccount,
  PublicMedia,
  PublicPost,
  TargetIssue,
} from "../types.js";

export type * from "../types.js";

export interface PostSyncClientOptions {
  /** Where the handler is mounted, e.g. "/social" (same origin) or "https://api.example.com/social". */
  baseUrl: string;
  /** Extra headers for every request, e.g. your API's Authorization header. May be a (async) function. */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  /** Fetch credentials mode (default "same-origin"; use "include" for cookie auth across origins). */
  credentials?: "omit" | "same-origin" | "include";
  /** Custom fetch (defaults to the global one). */
  fetch?: typeof fetch;
}

/** An error response from the API. */
export class PostSyncClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Per-account problems, for 400s from creating or validating a post. */
    readonly issues?: TargetIssue[],
  ) {
    super(message);
    this.name = "PostSyncClientError";
  }
}

export interface UploadOptions {
  /** Called with a 0..1 fraction while uploading (needs XMLHttpRequest, i.e. a browser). */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/**
 * What the OAuth callback appended to your `returnTo` page. Status "confirm": the callback couldn't tell that this
 * browser started the login (e.g. cookies were blocked), so the logged-in user must finish it with
 * `connect.confirm(confirm)`. `connect.finish()` handles that for you.
 */
export interface ConnectResult {
  status: "connected" | "confirm" | "error";
  /** Platform name, e.g. "Meta (Facebook + Instagram)". */
  connector: string;
  /** Number of accounts connected (status "connected"). */
  count?: number;
  /** Why it failed (status "error"). */
  error?: string;
  /** Token for `connect.confirm()` (status "confirm"). */
  confirm?: string;
}

export type PostSyncClient = ReturnType<typeof createPostSyncClient>;

export function createPostSyncClient(options: PostSyncClientOptions) {
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch: typeof fetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
  const credentials = options.credentials ?? "same-origin";

  async function headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    const h = typeof options.headers === "function" ? await options.headers() : (options.headers ?? {});
    return { ...h, ...extra };
  }

  async function errorFrom(res: Response): Promise<PostSyncClientError> {
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      // not JSON
    }
    return new PostSyncClientError(body?.error ?? `Request failed (${res.status})`, res.status, body?.issues);
  }

  async function call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await doFetch(base + path, {
      method,
      credentials,
      signal,
      headers: await headers(body === undefined ? {} : { "content-type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw await errorFrom(res);
    return (await res.json()) as T;
  }

  const enc = encodeURIComponent;

  async function upload(files: Blob | Blob[], opts: UploadOptions = {}): Promise<PublicMedia[]> {
    const list = Array.isArray(files) ? files : [files];
    const form = new FormData();
    for (const f of list) form.append("file", f, (f as File).name ?? "upload");
    const XHR = (globalThis as any).XMLHttpRequest;
    if (opts.onProgress && XHR && !options.fetch) {
      const h = await headers();
      return new Promise((resolve, reject) => {
        // An abort before this point (e.g. while `headers()` ran) fires no event the listener below could catch.
        if (opts.signal?.aborted) return reject(new PostSyncClientError("Upload cancelled.", 0));
        const xhr = new XHR();
        xhr.open("POST", `${base}/media`);
        xhr.withCredentials = credentials === "include";
        for (const [k, v] of Object.entries(h)) xhr.setRequestHeader(k, v);
        xhr.upload.onprogress = (e: { lengthComputable: boolean; loaded: number; total: number }) => e.lengthComputable && opts.onProgress!(e.loaded / e.total);
        xhr.onload = () => {
          let body: any = null;
          try {
            body = JSON.parse(xhr.responseText);
          } catch {
            // not JSON
          }
          if (xhr.status >= 200 && xhr.status < 300) resolve(body.media);
          else reject(new PostSyncClientError(body?.error ?? `Upload failed (${xhr.status})`, xhr.status));
        };
        xhr.onerror = () => reject(new PostSyncClientError("Upload failed: network error.", 0));
        xhr.onabort = () => reject(new PostSyncClientError("Upload cancelled.", 0));
        opts.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
        xhr.send(form);
      });
    }
    const res = await doFetch(`${base}/media`, { method: "POST", credentials, signal: opts.signal, headers: await headers(), body: form });
    if (!res.ok) throw await errorFrom(res);
    const { media } = (await res.json()) as { media: PublicMedia[] };
    opts.onProgress?.(1);
    return media;
  }

  /**
   * Reads the result the OAuth callback added to your `returnTo` page (`?postsync=connected&...`).
   * Returns null when the page wasn't opened by a login.
   */
  function parseResult(search: string = (globalThis as any).location?.search ?? ""): ConnectResult | null {
    const q = new URLSearchParams(search);
    const status = q.get("postsync");
    if (status !== "connected" && status !== "confirm" && status !== "error") return null;
    return {
      status,
      connector: q.get("connector") ?? "",
      count: q.has("count") ? Number(q.get("count")) : undefined,
      error: q.get("error") ?? undefined,
      confirm: q.get("confirm") ?? undefined,
    };
  }

  /** Finishes a login that came back with status "confirm", for the logged-in user. Returns the connected accounts. */
  async function confirm(token: string): Promise<PublicAccount[]> {
    return (await call<{ accounts: PublicAccount[] }>("POST", "/connect/confirm", { confirm: token })).accounts;
  }

  return {
    /** Platforms, their options and limits, and which ones are set up. Use it to build your composer UI. */
    platforms: () => call<Description>("GET", "/platforms"),

    accounts: {
      list: async () => (await call<{ accounts: PublicAccount[] }>("GET", "/accounts")).accounts,
      get: async (id: string) => (await call<{ account: PublicAccount }>("GET", `/accounts/${enc(id)}`)).account,
      /** Disconnects an account (fails with 409 while it has queued posts). */
      remove: async (id: string) => void (await call("DELETE", `/accounts/${enc(id)}`)),
      /** Checks that the saved login still works, without posting. */
      check: (id: string) => call<CheckResult>("POST", `/accounts/${enc(id)}/check`),
    },

    connect: {
      /**
       * URL to navigate to for an OAuth login when you authenticate with cookies (a plain link works).
       * With header auth (tokens), use `start()` instead: a browser navigation can't carry your headers.
       */
      url: (connector: ConnectorId | string, opts: { returnTo?: string } = {}) =>
        `${base}/connect/${enc(connector)}${opts.returnTo ? `?returnTo=${enc(opts.returnTo)}` : ""}`,
      /** Starts an OAuth login and returns the platform's login URL. Send the browser there. */
      start: (connector: ConnectorId | string, opts: { returnTo?: string } = {}) =>
        call<{ url: string }>("POST", `/connect/${enc(connector)}`, { returnTo: opts.returnTo }),
      /** `start()` + navigate the current window to the platform's login page. */
      redirect: async (connector: ConnectorId | string, opts: { returnTo?: string } = {}) => {
        const { url } = await call<{ url: string }>("POST", `/connect/${enc(connector)}`, { returnTo: opts.returnTo });
        (globalThis as any).location.assign(url);
      },
      /** Connects a form-based platform (Bluesky: `{ identifier, appPassword, service? }`). */
      withCredentials: async (connector: ConnectorId | string, fields: Record<string, string>) =>
        (await call<{ accounts: PublicAccount[] }>("POST", `/connect/${enc(connector)}/credentials`, { fields })).accounts,
      /**
       * Reads the result the OAuth callback added to your `returnTo` page (`?postsync=connected&...`).
       * Returns null when the page wasn't opened by a login.
       */
      parseResult,
      /** Finishes a login that came back with status "confirm" (its `confirm` token), for the logged-in user. */
      confirm,
      /**
       * Reads the login result on your `returnTo` page and, for status "confirm", finishes the login as the logged-in
       * user. Resolves to status "connected" or "error" (null when the page wasn't opened by a login); throws a
       * PostSyncClientError when confirming fails. Remove the `postsync`, `connector`, `count`, `error` and `confirm`
       * parameters from the address bar afterwards.
       */
      finish: async (search?: string): Promise<ConnectResult | null> => {
        const result = parseResult(search);
        if (result?.status !== "confirm") return result;
        const accounts = await confirm(result.confirm ?? "");
        return { status: "connected", connector: result.connector, count: accounts.length };
      },
    },

    media: {
      /** Uploads files (File/Blob). Pass `onProgress` for an upload progress bar. */
      upload,
      /** Imports a file from a URL (only if the server enabled `allowRemoteMedia` for it). */
      fromUrl: async (url: string, opts: { filename?: string } = {}) =>
        (await call<{ media: PublicMedia }>("POST", "/media/from-url", { url, filename: opts.filename })).media,
      get: async (id: string) => (await call<{ media: PublicMedia }>("GET", `/media/${enc(id)}`)).media,
      remove: async (id: string) => void (await call("DELETE", `/media/${enc(id)}`)),
    },

    posts: {
      /** Checks the post against every selected account's rules: one entry per account, fine when its `errors` is empty. */
      validate: async (req: PostRequest) => (await call<{ issues: TargetIssue[] }>("POST", "/posts/validate", req)).issues,
      /** Creates the post and queues publishing (now, or at `scheduledAt`). Throws with `issues` if it's invalid. */
      create: async (req: PostRequest) => (await call<{ post: PublicPost }>("POST", "/posts", req)).post,
      /** Newest first. Pass the previous page's `nextBefore` as `before` for the next page. */
      list: (opts: { limit?: number; before?: string | null } = {}) => {
        const q = new URLSearchParams();
        if (opts.limit) q.set("limit", String(opts.limit));
        if (opts.before) q.set("before", String(opts.before));
        const qs = q.toString();
        return call<PostPage>("GET", `/posts${qs ? `?${qs}` : ""}`);
      },
      get: async (id: string) => (await call<{ post: PublicPost }>("GET", `/posts/${enc(id)}`)).post,
      /** Removes the post from the history (what was published stays online). */
      remove: async (id: string) => void (await call("DELETE", `/posts/${enc(id)}`)),
    },

    targets: {
      /** Queues a failed or cancelled publish job again. */
      retry: async (id: string) => void (await call("POST", `/targets/${enc(id)}/retry`)),
      /** Cancels a queued or scheduled publish job. */
      cancel: async (id: string) => void (await call("POST", `/targets/${enc(id)}/cancel`)),
    },
  };
}
