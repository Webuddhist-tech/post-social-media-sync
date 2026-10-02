import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { UNMATCHED_HEADER, type PostSyncHandler, type RequestContext } from "../handler/index.js";

/** Converts a Node.js request into a web Request (streams the body; reuses a body already parsed by middleware). */
export function toWebRequest(req: IncomingMessage & { originalUrl?: string; body?: unknown }): Request {
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0].trim() || ((req.socket as any)?.encrypted ? "https" : "http");
  const host = req.headers.host ?? "localhost";
  // Express rewrites req.url inside a mounted router; originalUrl keeps the full path.
  const url = new URL(req.originalUrl ?? req.url ?? "/", `${proto}://${host}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
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
function bodyStream(req: IncomingMessage): ReadableStream<Uint8Array> {
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
export async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
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
 * A `(req, res, next?)` handler for Node's http server, Express, Connect, Koa (`ctx.req/ctx.res`) and NestJS.
 * Unknown paths call `next()` when given (so it can sit in a middleware chain), else answer 404.
 */
export function toNodeHandler(handler: PostSyncHandler, options: NodeHandlerOptions = {}) {
  return async function postSyncNodeHandler(req: IncomingMessage & Record<string, any>, res: ServerResponse, next?: (err?: unknown) => void) {
    try {
      const context: RequestContext | undefined = options.authenticate ? { getOwnerId: () => options.authenticate!(req) } : undefined;
      const response = await handler.fetch(toWebRequest(req), context);
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
