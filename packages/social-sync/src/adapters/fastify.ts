import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { createHandler, type HandlerOptions } from "../handler/index.js";
import type { PostSync } from "../sync.js";
import { sendWebResponse, toWebRequest } from "./node.js";

export interface FastifyOptions extends Omit<HandlerOptions, "authenticate"> {
  sync: PostSync;
  /** Returns the logged-in user's (or workspace's) id from the Fastify request, or null (→ 401). */
  authenticate: (request: FastifyRequest) => string | null | undefined | Promise<string | null | undefined>;
}

/**
 * Fastify plugin serving the Post Sync HTTP API. Register it with a prefix equal to the path of `publicUrl`:
 *
 * ```ts
 * await app.register(postSyncFastify, { prefix: "/social", sync, authenticate: (req) => req.user?.id });
 * ```
 */
export const postSyncFastify: FastifyPluginAsync<FastifyOptions> = async (fastify, opts) => {
  const { sync, authenticate, ...handlerOptions } = opts;
  const handler = createHandler(sync, handlerOptions);

  // Let the handler read raw bodies itself (JSON and streaming uploads). Scoped to this plugin only.
  fastify.removeAllContentTypeParsers();
  fastify.addContentTypeParser("*", (_request, _payload, done) => done(null));

  const route = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.hijack();
    // raw.url is the full path (prefix included), which is what the handler expects.
    const response = await handler.fetch(toWebRequest(request.raw), { getOwnerId: () => authenticate(request) });
    await sendWebResponse(reply.raw, response);
  };
  fastify.all("/", route);
  fastify.all("/*", route);
};
