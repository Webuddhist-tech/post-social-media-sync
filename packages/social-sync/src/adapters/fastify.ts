import { Readable } from "node:stream";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest, HTTPMethods } from "fastify";
import { createHandler, UNMATCHED_HEADER, type HandlerOptions } from "../handler/index.js";
import type { PostSync } from "../sync.js";
import { toWebRequest } from "./node.js";

export interface FastifyOptions extends Omit<HandlerOptions, "authenticate"> {
  sync: PostSync;
  /** Returns the logged-in user's (or workspace's) id from the Fastify request, or null (→ 401). */
  authenticate: (request: FastifyRequest) => string | null | undefined | Promise<string | null | undefined>;
}

const METHODS: HTTPMethods[] = ["GET", "HEAD", "POST", "DELETE", "OPTIONS"];

/**
 * Fastify plugin serving the Post Sync HTTP API. Register it with a prefix equal to the path of `publicUrl`:
 *
 * ```ts
 * await app.register(postSyncFastify, { prefix: "/social", sync, authenticate: (req) => req.user?.id });
 * ```
 * Responses go through Fastify's reply, so your hooks (e.g. @fastify/cors, @fastify/cookie) and error handler apply.
 * Paths the API doesn't know go to your not-found handler.
 */
export const postSyncFastify: FastifyPluginAsync<FastifyOptions> = async (fastify, opts) => {
  const { sync, authenticate, ...handlerOptions } = opts;
  const handler = createHandler(sync, handlerOptions);

  // Let the handler read raw bodies itself (JSON and streaming uploads). Scoped to this plugin only.
  fastify.removeAllContentTypeParsers();
  fastify.addContentTypeParser("*", (_request, _payload, done) => done(null));

  const route = async (request: FastifyRequest, reply: FastifyReply) => {
    let webRequest: Request;
    try {
      // raw.url is the full path (prefix included), which is what the handler expects.
      webRequest = toWebRequest(request.raw);
    } catch {
      return reply.code(400).send({ error: "Bad request." });
    }
    const response = await handler.fetch(webRequest, { getOwnerId: () => authenticate(request) });
    if (response.headers.has(UNMATCHED_HEADER)) {
      await response.body?.cancel().catch(() => {});
      return reply.callNotFound();
    }
    reply.code(response.status);
    response.headers.forEach((value, key) => {
      if (key !== "set-cookie") reply.header(key, value);
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) reply.header("set-cookie", cookies);
    // No body is `undefined`, not `null`: Fastify would serialize null as a JSON "null" body.
    return reply.send(response.body ? Readable.fromWeb(response.body as any) : undefined);
  };
  fastify.route({ method: METHODS, url: "/", handler: route });
  fastify.route({ method: METHODS, url: "/*", handler: route });
};
