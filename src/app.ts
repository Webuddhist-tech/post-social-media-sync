import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { AccountService } from "./accounts.js";
import { Auth } from "./auth.js";
import type { Config } from "./config.js";
import { Secrets } from "./crypto.js";
import { openDatabase, type DB } from "./db.js";
import { ApiError, AuthError, UserError } from "./http.js";
import { MediaStore } from "./media.js";
import { PostService } from "./posts.js";
import { apiRoutes } from "./routes/api.js";
import { oauthRoutes } from "./routes/oauth.js";
import { Worker } from "./worker.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.resolve(here, "..", "public");

export interface AppServices {
  config: Config;
  db: DB;
  secrets: Secrets;
  auth: Auth;
  media: MediaStore;
  accounts: AccountService;
  posts: PostService;
  worker: Worker;
}

declare module "fastify" {
  interface FastifyInstance {
    services: AppServices;
  }
}

export interface BuildOptions {
  config: Config;
  logger?: FastifyServerOptions["logger"];
  /** Database file; defaults to <DATA_DIR>/app.db. Tests pass ":memory:". */
  dbFile?: string;
  /** Overrides waiting in publishers (tests). */
  sleep?: (ms: number) => Promise<void>;
  startWorker?: boolean;
}

export async function buildApp(opts: BuildOptions): Promise<FastifyInstance> {
  const { config } = opts;
  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: true,
    bodyLimit: 5 * 1024 * 1024,
  });

  const db = openDatabase(opts.dbFile ?? path.join(config.dataDir, "app.db"));
  const secrets = new Secrets(config.appSecret);
  const media = new MediaStore(db, config, secrets);
  const accounts = new AccountService(db, secrets, config);
  const posts = new PostService(db, media, config);
  const auth = new Auth(config, secrets);
  const worker = new Worker({ db, config, accounts, posts, media, log: app.log, sleep: opts.sleep });
  app.decorate("services", { config, db, secrets, auth, media, accounts, posts, worker });

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 20, fields: 20 } });
  await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: "/", index: ["index.html"], wildcard: false });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof UserError) {
      return reply.code(400).send({ error: err.message, issues: (err as any).issues });
    }
    if (err instanceof AuthError) return reply.code(400).send({ error: err.message });
    if (err instanceof ApiError) return reply.code(502).send({ error: err.message });
    if (err.validation || (err.statusCode && err.statusCode < 500)) {
      return reply.code(err.statusCode ?? 400).send({ error: err.message });
    }
    req.log.error(err);
    return reply.code(500).send({ error: "Internal server error" });
  });

  app.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "same-origin");
  });

  app.get("/healthz", async () => ({ ok: true }));

  // Signed, unguessable media URLs. Public on purpose: Instagram/Threads servers download from here.
  app.get<{ Params: { sig: string; file: string } }>("/media/:sig/:file", async (req, reply) => {
    const { sig, file } = req.params;
    if (!media.verifyPublicUrl(sig, file)) return reply.code(404).send({ error: "Not found" });
    reply.header("Cache-Control", "public, max-age=86400");
    return reply.sendFile(file, config.mediaDir);
  });

  await app.register(oauthRoutes);
  await app.register(apiRoutes, { prefix: "/api" });

  app.addHook("onClose", async () => {
    await worker.stop(10_000);
    db.close();
  });

  if (opts.startWorker !== false) app.addHook("onReady", async () => worker.start());
  return app;
}
