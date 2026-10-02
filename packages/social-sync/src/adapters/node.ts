import type { IncomingMessage, ServerResponse } from "node:http";
import type { Http2ServerRequest, Http2ServerResponse } from "node:http2";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { UNMATCHED_HEADER, type PostSyncHandler, type RequestContext } from "../handler/index.js";

/** A Node.js request: node:http, node:https or the node:http2 compatibility API (plus what frameworks attach). */
export type NodeRequest = (IncomingMessage | Http2ServerRequest) & { originalUrl?: string; body?: unknown };
/** A Node.js response: node:http, node:https or the node:http2 compatibility API. */
export type NodeResponse = ServerResponse | Http2ServerResponse;

function firstHeader(req: NodeRequest, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** The scheme the client used: a proxy's X-Forwarded-Proto, HTTP/2's :scheme, else whether the socket is TLS. */
function requestScheme(req: NodeRequest): "http" | "https" {
  for (const raw of [firstHeader(req, "x-forwarded-proto")?.split(",")[0], firstHeader(req, ":scheme")]) {
    const value = raw?.trim().toLowerCase();
    if (value === "http" || value === "https") return value;
  }
  return (req.socket as any)?.encrypted ? "https" : "http";
}

/** Host (HTTP/1) or :authority (HTTP/2); "localhost" when it is missing or isn't a plain host[:port]. */
function requestHost(req: NodeRequest): string {
  const host = firstHeader(req, "host") ?? firstHeader(req, ":authority");
  return host && !/[\s/\\?#@]/.test(host) && URL.canParse(`http://${host}`) ? host : "localhost";
}

/** Converts a Node.js request into a web Request (streams the body; reuses a body already parsed by middleware). */
export function toWebRequest(req: NodeRequest): Request {
  // Express rewrites req.url inside a mounted router; originalUrl keeps the full path. The target is appended, never
  // resolved: "//evil.example/social/posts" must stay a path on this origin, not become a URL on another one.
  const target = req.originalUrl ?? req.url ?? "/";
  const url = `${requestScheme(req)}://${requestHost(req)}${target.startsWith("/") ? target : "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    // HTTP/2 pseudo-headers (:method, :path, :scheme, :authority) aren't valid header names.
    if (value === undefined || key.startsWith(":")) continue;
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else headers.set(key, value);
  }
  const method = (req.method ?? "GET").toUpperCase();
  let body: RequestInit["body"] | undefined;
  if (method !== "GET" && method !== "HEAD") {
    // Body parsers that skipped this request (e.g. express.json() on a multipart upload) leave the stream unread.
    const alreadyParsed = req.body !== undefined && (req.readableDidRead || req.readableEnded);
    if (alreadyParsed) {
      // A body parser (e.g. express.json()) consumed the stream: re-serialize what it produced.
      body = typeof req.body === "string" || Buffer.isBuffer(req.body) ? (req.body as any) : JSON.stringify(req.body);
      headers.delete("content-length");
      if (typeof req.body === "object" && !Buffer.isBuffer(req.body)) headers.set("content-type", "application/json");
    } else {
      body = bodyStream(req);
    }
  }
  return new Request(url, { method, headers, body, duplex: "half" } as RequestInit);
}

/**
 * The request body as a web stream that reads only when the handler asks for it, so a request the handler doesn't
 * match is left untouched for the next middleware. Cancelling discards the rest instead of destroying the request,
 * which would drop the connection before the error response is sent. (Readable.toWeb does both, and can even throw
 * from a late "data" event after a cancel.)
 */
function bodyStream(req: NodeRequest): ReadableStream<Uint8Array> {
  let started = false;
  let stopped = false;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (!started) {
          started = true;
          req.on("data", (chunk: Buffer) => {
            if (stopped) return;
            controller.enqueue(new Uint8Array(chunk));
            if ((controller.desiredSize ?? 0) <= 0) req.pause();
          });
          req.once("end", () => !stopped && controller.close());
          req.once("error", (err) => !stopped && controller.error(err));
        }
        req.resume();
      },
      cancel() {
        stopped = true;
        req.resume();
      },
    },
    { highWaterMark: 0 },
  );
}

/** Writes a web Response to a Node.js response. */
export async function sendWebResponse(res: NodeResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    if (key === UNMATCHED_HEADER) return;
    if (key === "set-cookie") return;
    res.setHeader(key, value);
  });
  const cookies = (response.headers as any).getSetCookie?.() as string[] | undefined;
  if (cookies?.length) res.setHeader("set-cookie", cookies);
  if (!response.body) {
    res.end();
    return;
  }
  await pipeline(Readable.fromWeb(response.body as any), res).catch(() => {
    // client went away mid-download; nothing to do
  });
}

export interface NodeHandlerOptions {
  /** Resolve the owner id from the Node request (e.g. a session your middleware attached). */
  authenticate?: (req: IncomingMessage & Record<string, any>) => string | null | undefined | Promise<string | null | undefined>;
}

/**
 * A `(req, res, next?)` handler for Node's http/https/http2 servers, Express, Connect, Koa (`ctx.req/ctx.res`) and
 * NestJS. Unknown paths call `next()` when given (so it can sit in a middleware chain), else answer 404.
 */
export function toNodeHandler(handler: PostSyncHandler, options: NodeHandlerOptions = {}) {
  return async function postSyncNodeHandler(req: NodeRequest & Record<string, any>, res: NodeResponse, next?: (err?: unknown) => void) {
    let request: Request;
    try {
      request = toWebRequest(req);
    } catch {
      // Something a web Request can't carry (e.g. the TRACE method): not for this handler.
      if (next) return next();
      const headers = { "content-type": "application/json; charset=utf-8" };
      return sendWebResponse(res, new Response(JSON.stringify({ error: "Bad request." }), { status: 400, headers }));
    }
    try {
      const context: RequestContext | undefined = options.authenticate ? { getOwnerId: () => options.authenticate!(req as any) } : undefined;
      const response = await handler.fetch(request, context);
      if (response.headers.has(UNMATCHED_HEADER) && next) {
        await response.body?.cancel().catch(() => {});
        return next();
      }
      await sendWebResponse(res, response);
    } catch (err) {
      if (next) return next(err);
      res.statusCode = 500;
      res.end("Internal server error");
    }
  };
}
