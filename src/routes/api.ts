import type { FastifyInstance } from "fastify";
import { isPrivateBaseUrl } from "../config.js";
import { UserError } from "../http.js";
import { hasFfmpeg, SUPPORTED_MIME_TYPES } from "../media.js";
import { CONNECTORS, getConnector, PLATFORMS } from "../platforms/index.js";
import type { PostRequest } from "../posts.js";
import { redirectUri } from "./oauth.js";

function isSameOrigin(origin: string, host: string, publicBaseUrl: string): boolean {
  try {
    const o = new URL(origin);
    return o.host === host || o.origin === new URL(publicBaseUrl).origin;
  } catch {
    return false;
  }
}

export async function apiRoutes(app: FastifyInstance): Promise<void> {
  const { config, db, auth, media, accounts, posts, worker } = app.services;

  // ---- session (public) ----------------------------------------------------
  app.post<{ Body: { password?: string } }>("/login", async (req, reply) => {
    const result = auth.login(String(req.body?.password ?? ""), req.ip);
    if (!result.ok) {
      if (result.retryAfterSec) {
        reply.header("Retry-After", String(result.retryAfterSec));
        return reply.code(429).send({ error: `Too many attempts. Try again in ${Math.ceil(result.retryAfterSec / 60)} min.` });
      }
      return reply.code(401).send({ error: "Wrong password." });
    }
    auth.setCookie(reply, result.cookie);
    return { ok: true };
  });

  app.post("/logout", async (_req, reply) => {
    auth.clearCookie(reply);
    return { ok: true };
  });

  app.get("/session", async (req) => ({ authenticated: auth.isAuthenticated(req) }));

  // ---- everything below requires login --------------------------------------
  await app.register(async (api) => {
    api.addHook("onRequest", async (req, reply) => {
      if (!auth.isAuthenticated(req)) return reply.code(401).send({ error: "Not logged in." });
      // Cookie-authenticated writes must come from our own pages (CSRF defense on top of SameSite=Lax).
      const origin = req.headers.origin;
      if (origin && req.method !== "GET" && !req.headers.authorization && !isSameOrigin(origin, req.host, config.publicBaseUrl)) {
        return reply.code(403).send({ error: "Cross-origin request blocked." });
      }
    });

    api.get("/meta", async () => ({
      publicBaseUrl: config.publicBaseUrl,
      publicMediaReachable: !isPrivateBaseUrl(config.publicBaseUrl),
      ffmpeg: await hasFfmpeg(),
      maxUploadMb: Math.round(config.maxUploadBytes / 1024 / 1024),
      supportedMimeTypes: SUPPORTED_MIME_TYPES,
      platforms: Object.values(PLATFORMS).map((p) => ({
        id: p.id,
        name: p.name,
        connector: p.connector,
        capabilities: p.capabilities,
        options: p.options,
      })),
      connectors: Object.values(CONNECTORS).map((c) => ({
        id: c.id,
        name: c.name,
        platforms: c.platforms,
        kind: c.kind,
        configured: c.isConfigured(config),
        envVars: c.envVars,
        developerPortal: c.developerPortal ?? null,
        redirectUri: c.kind === "oauth" ? redirectUri(config.publicBaseUrl, c.id) : null,
        credentialFields: c.credentialFields ?? null,
      })),
    }));

    // ---- accounts -----------------------------------------------------------
    api.get("/accounts", async () => ({ accounts: accounts.list() }));

    api.delete<{ Params: { id: string } }>("/accounts/:id", async (req, reply) => {
      if (db.hasActiveTargetsForAccount(req.params.id)) {
        return reply.code(409).send({ error: "This account has queued or running posts. Cancel them first." });
      }
      if (!db.deleteAccount(req.params.id)) return reply.code(404).send({ error: "Account not found." });
      return { ok: true };
    });

    api.post<{ Params: { connector: string }; Body: { fields?: Record<string, string> } }>(
      "/connect/:connector/credentials",
      async (req, reply) => {
        const connector = getConnector(req.params.connector);
        if (!connector?.connectWithCredentials) return reply.code(404).send({ error: "Unknown connector." });
        const drafts = await connector.connectWithCredentials(config, req.body?.fields ?? {});
        const ids = accounts.saveDrafts(connector.id, drafts);
        return { accounts: accounts.list().filter((a) => ids.includes(a.id)) };
      },
    );

    // ---- media ---------------------------------------------------------------
    api.post("/media", async (req) => {
      if (!req.isMultipart()) throw new UserError("Upload files as multipart/form-data.");
      const saved = [];
      for await (const part of req.files()) {
        const row = await media.save(part.file, part.filename, part.mimetype);
        saved.push({
          id: row.id,
          filename: row.filename,
          kind: row.kind,
          mime: row.mime,
          size: row.size,
          width: row.width,
          height: row.height,
          duration: row.duration,
          previewUrl: media.previewPath(row.file),
          thumbUrl: media.thumbPath(row),
        });
      }
      if (!saved.length) throw new UserError("No files received.");
      return { media: saved };
    });

    // ---- posts ----------------------------------------------------------------
    api.post<{ Body: PostRequest }>("/posts/validate", async (req) => ({ issues: posts.validate(req.body ?? ({} as PostRequest)) }));

    api.post<{ Body: PostRequest }>("/posts", async (req, reply) => {
      const { post } = posts.create(req.body ?? ({} as PostRequest));
      worker.kick();
      return reply.code(201).send({ post: posts.serialize([post])[0] });
    });

    api.get<{ Querystring: { limit?: string; before?: string } }>("/posts", async (req) => {
      const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20) || 20));
      const before = req.query.before ? Number(req.query.before) : undefined;
      const rows = db.listPosts(limit, before);
      return {
        posts: posts.serialize(rows),
        nextBefore: rows.length === limit ? rows[rows.length - 1].created_at : null,
      };
    });

    api.get<{ Params: { id: string } }>("/posts/:id", async (req, reply) => {
      const row = db.getPost(req.params.id);
      if (!row) return reply.code(404).send({ error: "Post not found." });
      return { post: posts.serialize([row])[0] };
    });

    /** Removes the post from the history (doesn't delete it from the platforms). */
    api.delete<{ Params: { id: string } }>("/posts/:id", async (req, reply) => {
      const row = db.getPost(req.params.id);
      if (!row) return reply.code(404).send({ error: "Post not found." });
      const targets = db.targetsForPosts([row.id]);
      if (targets.some((t) => t.status === "running")) {
        return reply.code(409).send({ error: "This post is still publishing. Wait for it to finish." });
      }
      db.deletePost(row.id);
      await media.removeIfUnused(JSON.parse(row.media_ids));
      return { ok: true };
    });

    api.post<{ Params: { id: string } }>("/targets/:id/retry", async (req, reply) => {
      if (!db.retryTarget(req.params.id)) return reply.code(409).send({ error: "Only failed or cancelled posts can be retried." });
      worker.kick();
      return { ok: true };
    });

    api.post<{ Params: { id: string } }>("/targets/:id/cancel", async (req, reply) => {
      if (!db.cancelTarget(req.params.id)) return reply.code(409).send({ error: "Only queued or scheduled posts can be cancelled." });
      return { ok: true };
    });
  });
}
