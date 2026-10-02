import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { ApiError, AuthError, UserError } from "../http.js";
import { mimeFromFilename } from "../media.js";
import { ConnectError, type PostSync } from "../sync.js";
import { parseMultipart } from "./multipart.js";

export interface HandlerOptions {
  /**
   * Who is calling: return your user's (or workspace's) id, or null if not logged in (→ 401).
   * Called only for routes that need it (not for OAuth callbacks or public media files).
   * Framework adapters (Express/Fastify) take an equivalent option that receives the framework's request.
   */
  authenticate?: (request: Request) => string | null | undefined | Promise<string | null | undefined>;
  /** Path where the handler is mounted (default: the path of `publicUrl`). */
  basePath?: string;
  /**
   * Origins your frontend may be sent back to after connecting an account (`returnTo`).
   * Default: the origin of `publicUrl`. Relative paths are always allowed.
   */
  allowedRedirectOrigins?: string[];
  /** Where to send the browser after an OAuth login when no `returnTo` was given (default: `/` on publicUrl's origin). */
  defaultReturnTo?: string;
  /**
   * Allow POST /media/from-url, which makes your server download a URL. Return true for URLs you trust
   * (e.g. your own bucket). Off by default.
   */
  allowRemoteMedia?: (url: URL) => boolean;
  /** CORS for frontends on another origin. Skip this if your framework already handles CORS. */
  cors?: { origins: string[]; credentials?: boolean };
  /** Max JSON body size in bytes (default 1 MB). */
  maxJsonBytes?: number;
  /**
   * Reject state-changing requests (POST/DELETE) whose browser `Origin` header is not publicUrl's origin, an
   * `allowedRedirectOrigins` entry, a `cors.origins` entry, or the request's own origin. Protects cookie-based
   * logins from cross-site request forgery. Requests without an Origin header (servers, scripts) are not affected.
   * Default true.
   */
  checkOrigin?: boolean;
}

/** Per-request context supplied by framework adapters. */
export interface RequestContext {
  /** Resolves the owner id using the framework's own request object. */
  getOwnerId?: () => string | null | undefined | Promise<string | null | undefined>;
}

export interface PostSyncHandler {
  /** Handles a standard web Request (Next.js, Hono, Bun, Deno, Remix, …). */
  fetch(request: Request, context?: RequestContext): Promise<Response>;
  readonly basePath: string;
}

type Params = Record<string, string>;
interface Ctx {
  request: Request;
  url: URL;
  params: Params;
  ownerId: string;
}
interface Route {
  method: string;
  pattern: string[];
  auth: boolean;
  run: (ctx: Ctx) => Promise<Response>;
}

/** Marks "no route matched" so adapters can fall through to the host app (e.g. Express `next()`). */
export const UNMATCHED_HEADER = "x-post-sync-unmatched";

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
const fail = (status: number, error: string, extra: Record<string, unknown> = {}) => json({ error, ...extra }, status);
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

/** Creates the HTTP API for your frontend. Mount it at the path of `publicUrl`. */
export function createHandler(sync: PostSync, options: HandlerOptions = {}): PostSyncHandler {
  const publicUrl = new URL(sync.config.publicBaseUrl);
  const basePath = (options.basePath ?? publicUrl.pathname).replace(/\/+$/, "");
  const allowedOrigins = new Set((options.allowedRedirectOrigins ?? [publicUrl.origin]).map((o) => new URL(o).origin));
  const defaultReturnTo = options.defaultReturnTo ?? `${publicUrl.origin}/`;
  const maxJson = options.maxJsonBytes ?? 1024 * 1024;
  const trustedOrigins = new Set([publicUrl.origin, ...allowedOrigins, ...(options.cors?.origins ?? [])]);

  function originAllowed(request: Request, url: URL): boolean {
    if (options.checkOrigin === false) return true;
    if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return true;
    const origin = request.headers.get("origin");
    if (!origin) return true;
    return origin === url.origin || trustedOrigins.has(origin);
  }

  /** Only allow sending browsers back to our own (or explicitly allowed) origins: no open redirects. */
  function resolveReturnTo(raw: unknown): string {
    if (raw === undefined || raw === null || raw === "") return defaultReturnTo;
    if (typeof raw !== "string") throw new UserError("`returnTo` must be a URL.");
    if (raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/\\")) return new URL(raw, publicUrl.origin).toString();
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new UserError("`returnTo` must be an absolute URL or a path starting with /.");
    }
    if ((u.protocol !== "https:" && u.protocol !== "http:") || !allowedOrigins.has(u.origin)) {
      throw new UserError(`returnTo origin ${u.origin} isn't allowed. Add it to allowedRedirectOrigins.`);
    }
    return u.toString();
  }

  function withParams(target: string, params: Record<string, string>): string {
    const u = new URL(target);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  }

  async function readJson(request: Request): Promise<any> {
    const type = request.headers.get("content-type") ?? "";
    if (!request.body) return {};
    if (!type.includes("application/json")) {
      await request.body.cancel().catch(() => {});
      if (type) throw new UserError("Send JSON (Content-Type: application/json).");
      return {};
    }
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxJson) {
        await reader.cancel().catch(() => {});
        throw Object.assign(new UserError("Request body too large."), { status: 413 });
      }
      chunks.push(value);
    }
    const text = Buffer.concat(chunks).toString("utf8").trim();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new UserError("Invalid JSON body.");
    }
  }

  const routes: Route[] = [];
  const add = (method: string, pattern: string, auth: boolean, run: Route["run"]) =>
    routes.push({ method, pattern: pattern.split("/").filter(Boolean), auth, run });

  // ---- public routes (no login): OAuth callback and signed media files -----------------------

  add("GET", "/oauth/:connector/callback", false, async ({ url, params }) => {
    const query = Object.fromEntries(url.searchParams);
    try {
      const result = await sync.connect.complete(params.connector, query);
      const back = result.returnTo ?? defaultReturnTo;
      return redirect(withParams(back, { postsync: "connected", connector: result.connector, count: String(result.accounts.length) }));
    } catch (err) {
      if (err instanceof ConnectError) {
        return redirect(withParams(err.returnTo ?? defaultReturnTo, { postsync: "error", connector: err.connector, error: err.message }));
      }
      throw err;
    }
  });

  add("GET", "/media/:sig/:file", false, async ({ request, params }) => serveFile(request, params.sig, params.file));

  // ---- account management -----------------------------------------------------------------------

  add("GET", "/platforms", true, async () => json(await sync.describe()));

  add("GET", "/accounts", true, async ({ ownerId }) => json({ accounts: await sync.accounts.list(ownerId) }));

  add("GET", "/accounts/:id", true, async ({ ownerId, params }) => {
    const account = await sync.accounts.get(ownerId, params.id);
    return account ? json({ account }) : fail(404, "Account not found.");
  });

  add("DELETE", "/accounts/:id", true, async ({ ownerId, params }) => {
    const result = await sync.accounts.remove(ownerId, params.id);
    if (result === "not_found") return fail(404, "Account not found.");
    if (result === "busy") return fail(409, "This account has queued or running posts. Cancel them first.");
    return json({ ok: true });
  });

  add("POST", "/accounts/:id/check", true, async ({ ownerId, params }) => {
    const result = await sync.accounts.check(ownerId, params.id);
    return result ? json(result) : fail(404, "Account not found.");
  });

  // Browser navigation (cookie sessions): /connect/meta?returnTo=/settings → platform login page.
  add("GET", "/connect/:connector", true, async ({ ownerId, params, url }) => {
    const returnTo = resolveReturnTo(url.searchParams.get("returnTo"));
    try {
      const { url: authUrl } = await sync.connect.start(ownerId, params.connector, { returnTo });
      return redirect(authUrl);
    } catch (err) {
      if (err instanceof UserError) return redirect(withParams(returnTo, { postsync: "error", connector: params.connector, error: err.message }));
      throw err;
    }
  });

  // SPA / token auth: POST /connect/meta { returnTo } → { url }; then set window.location to it.
  add("POST", "/connect/:connector", true, async ({ request, ownerId, params }) => {
    const body = await readJson(request);
    return json(await sync.connect.start(ownerId, params.connector, { returnTo: resolveReturnTo(body.returnTo) }));
  });

  add("POST", "/connect/:connector/credentials", true, async ({ request, ownerId, params }) => {
    const body = await readJson(request);
    const fields = body.fields && typeof body.fields === "object" ? body.fields : {};
    return json({ accounts: await sync.connect.withCredentials(ownerId, params.connector, fields) }, 201);
  });

  // ---- media ------------------------------------------------------------------------------------------

  add("POST", "/media", true, async ({ request, ownerId }) => {
    const media = await parseMultipart(request, {
      maxFileBytes: sync.config.maxUploadBytes,
      maxFiles: 20,
      onFile: (file) => sync.media.upload(ownerId, file),
    });
    if (!media.length) throw new UserError("No files received. Send them as multipart/form-data.");
    return json({ media }, 201);
  });

  add("POST", "/media/from-url", true, async ({ request, ownerId }) => {
    const body = await readJson(request);
    let target: URL;
    try {
      target = new URL(String(body.url ?? ""));
    } catch {
      throw new UserError("Send { url } with an absolute http(s) URL.");
    }
    if (!options.allowRemoteMedia?.(target)) return fail(403, "Importing media from URLs isn't enabled for this server.");
    const media = await sync.media.fromUrl(ownerId, target.toString(), {
      filename: typeof body.filename === "string" ? body.filename : undefined,
      allow: options.allowRemoteMedia,
    });
    return json({ media }, 201);
  });

  add("GET", "/media/:id", true, async ({ ownerId, params }) => {
    const media = await sync.media.get(ownerId, params.id);
    return media ? json({ media }) : fail(404, "Media not found.");
  });

  add("DELETE", "/media/:id", true, async ({ ownerId, params }) => {
    const result = await sync.media.remove(ownerId, params.id);
    if (result === "not_found") return fail(404, "Media not found.");
    if (result === "in_use") return fail(409, "A post uses this file. Remove the post first.");
    return json({ ok: true });
  });

  // ---- posts ---------------------------------------------------------------------------------------------

  add("POST", "/posts/validate", true, async ({ request, ownerId }) => json({ issues: await sync.posts.validate(ownerId, await readJson(request)) }));

  add("POST", "/posts", true, async ({ request, ownerId }) => json({ post: await sync.posts.create(ownerId, await readJson(request)) }, 201));

  add("GET", "/posts", true, async ({ ownerId, url }) => {
    const limit = Number(url.searchParams.get("limit") ?? 20);
    const before = url.searchParams.get("before");
    return json(await sync.posts.list(ownerId, { limit, before: before ? Number(before) : undefined }));
  });

  add("GET", "/posts/:id", true, async ({ ownerId, params }) => {
    const post = await sync.posts.get(ownerId, params.id);
    return post ? json({ post }) : fail(404, "Post not found.");
  });

  add("DELETE", "/posts/:id", true, async ({ ownerId, params }) => {
    const result = await sync.posts.remove(ownerId, params.id);
    if (result === "not_found") return fail(404, "Post not found.");
    if (result === "running") return fail(409, "This post is still publishing. Wait for it to finish.");
    return json({ ok: true });
  });

  add("POST", "/targets/:id/retry", true, async ({ ownerId, params }) =>
    (await sync.targets.retry(ownerId, params.id)) ? json({ ok: true }) : fail(409, "Only failed or cancelled posts can be retried."),
  );

  add("POST", "/targets/:id/cancel", true, async ({ ownerId, params }) =>
    (await sync.targets.cancel(ownerId, params.id)) ? json({ ok: true }) : fail(409, "Only queued or scheduled posts can be cancelled."),
  );

  // ---- files -----------------------------------------------------------------------------------------------

  async function serveFile(request: Request, sig: string, file: string): Promise<Response> {
    if (!sync.store.verifyPublicUrl(sig, file)) return fail(404, "Not found");
    const full = path.join(sync.config.mediaDir, file);
    let size: number;
    try {
      size = (await fsp.stat(full)).size;
    } catch {
      return fail(404, "Not found");
    }
    const headers: Record<string, string> = {
      "content-type": mimeFromFilename(file) ?? "application/octet-stream",
      "cache-control": "public, max-age=86400",
      "accept-ranges": "bytes",
    };
    let start = 0;
    let end = size - 1;
    let status = 200;
    const range = request.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
    if (range && size > 0) {
      if (range[1] === "") {
        start = Math.max(0, size - Number(range[2]));
      } else {
        start = Number(range[1]);
        if (range[2] !== "") end = Math.min(Number(range[2]), size - 1);
      }
      if (start > end || start >= size) {
        return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
      }
      status = 206;
      headers["content-range"] = `bytes ${start}-${end}/${size}`;
    }
    headers["content-length"] = String(size === 0 ? 0 : end - start + 1);
    if (request.method === "HEAD" || size === 0) return new Response(null, { status, headers });
    const stream = Readable.toWeb(fs.createReadStream(full, { start, end })) as ReadableStream;
    return new Response(stream, { status, headers });
  }

  // ---- dispatch ----------------------------------------------------------------------------------------------

  function corsHeaders(request: Request): Record<string, string> {
    const origin = request.headers.get("origin");
    if (!options.cors || !origin || !options.cors.origins.includes(origin)) return {};
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      "access-control-allow-headers": request.headers.get("access-control-request-headers") ?? "content-type, authorization",
      "access-control-max-age": "600",
      vary: "Origin",
      ...(options.cors.credentials ? { "access-control-allow-credentials": "true" } : {}),
    };
  }

  function match(method: string, segments: string[]): { route: Route; params: Params } | null {
    for (const route of routes) {
      if (route.method !== method && !(method === "HEAD" && route.method === "GET")) continue;
      if (route.pattern.length !== segments.length) continue;
      const params: Params = {};
      let ok = true;
      for (let i = 0; i < segments.length; i++) {
        const p = route.pattern[i];
        if (p.startsWith(":")) params[p.slice(1)] = segments[i];
        else if (p !== segments[i]) ok = false;
        if (!ok) break;
      }
      if (ok) return { route, params };
    }
    return null;
  }

  async function dispatch(request: Request, context?: RequestContext): Promise<Response> {
    const url = new URL(request.url);
    let pathname = url.pathname;
    if (basePath) {
      if (pathname !== basePath && !pathname.startsWith(basePath + "/")) return unmatched();
      pathname = pathname.slice(basePath.length);
    }
    let segments: string[];
    try {
      segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
    } catch {
      return fail(400, "Bad path.");
    }

    if (request.method === "OPTIONS" && options.cors) return new Response(null, { status: 204, headers: corsHeaders(request) });
    const found = match(request.method, segments);
    if (!found) return unmatched();

    if (found.route.auth && !originAllowed(request, url)) return fail(403, "Cross-origin request blocked.");
    try {
      let ownerId = "";
      if (found.route.auth) {
        const id = context?.getOwnerId ? await context.getOwnerId() : options.authenticate ? await options.authenticate(request) : null;
        if (id === null || id === undefined || id === "") return fail(401, "Not logged in.");
        ownerId = String(id);
      }
      return await found.route.run({ request, url, params: found.params, ownerId });
    } catch (err) {
      if (err instanceof UserError) return fail((err as any).status ?? 400, err.message, (err as any).issues ? { issues: (err as any).issues } : {});
      if (err instanceof AuthError) return fail(400, err.message);
      if (err instanceof ApiError) return fail(502, err.message);
      // e.g. an http-errors style error thrown by your authenticate() hook
      const status = (err as any)?.status ?? (err as any)?.statusCode;
      if (typeof status === "number" && status >= 400 && status < 500) return fail(status, (err as Error).message);
      sync.logger.error(`${request.method} ${url.pathname} failed`, err);
      return fail(500, "Internal server error");
    }
  }

  function unmatched(): Response {
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8", [UNMATCHED_HEADER]: "1" },
    });
  }

  return {
    basePath,
    async fetch(request, context) {
      const response = await dispatch(request, context);
      const cors = corsHeaders(request);
      for (const [k, v] of Object.entries(cors)) response.headers.set(k, v);
      return response;
    },
  };
}
