import type { IncomingMessage, ServerResponse } from "node:http";
import { createHandler, type HandlerOptions } from "../handler/index.js";
import type { PostSync } from "../sync.js";
import { toNodeHandler } from "./node.js";

export interface ExpressOptions extends Omit<HandlerOptions, "authenticate"> {
  /**
   * Returns the logged-in user's id (or workspace id) from the Express request, e.g. `(req) => req.user?.id`.
   * Return null when nobody is logged in (→ 401).
   */
  authenticate: (req: any) => string | null | undefined | Promise<string | null | undefined>;
}

/**
 * Express (and NestJS-on-Express) middleware serving the Post Sync HTTP API.
 *
 * ```ts
 * app.use("/social", postSyncExpress(sync, { authenticate: (req) => req.user?.id }));
 * ```
 * Mount it at the path of `publicUrl`. It works before or after `express.json()`.
 */
export function postSyncExpress(sync: PostSync, options: ExpressOptions) {
  const handler = createHandler(sync, options);
  const node = toNodeHandler(handler, { authenticate: options.authenticate });
  return (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
    void node(req as any, res, next);
  };
}
