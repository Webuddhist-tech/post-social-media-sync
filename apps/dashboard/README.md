# Post Sync server (`@post-sync/dashboard`)

The ready-to-run Post Sync app, built on the [`post-social-media-sync`](../../packages/social-sync) package. One
Fastify server that gives you:

- the Post Sync HTTP API under `/api` (accounts, OAuth logins, uploads, posts), for the dashboard and for your own
  backend or frontend;
- the web dashboard (password login), unless `DASHBOARD=off`;
- webhooks that POST every event to your backend (`WEBHOOK_URL`);
- `GET /healthz` for health checks.

## Run it

From the repository root:

```bash
npm install
cp .env.example .env          # set ADMIN_PASSWORD at least
npm run build && npm start    # or: npm run dev
```

Configuration comes from environment variables (or `.env` in the directory you start it in). Every variable is
described in [.env.example](../../.env.example); platform keys and redirect URIs in
[docs/PLATFORM_SETUP.md](../../docs/PLATFORM_SETUP.md). Redirect URIs are
`<PUBLIC_BASE_URL>/api/oauth/<connector>/callback`. The [root README](../../README.md#b-run-the-server) covers
Docker and getting a public HTTPS address.

## Headless mode

`DASHBOARD=off` turns off the web UI and the password login: the server is only the HTTP API, for backends in any
language. It then needs `API_TOKEN` (16+ characters). Your backend sends:

- `Authorization: Bearer <API_TOKEN>`
- `X-Owner-Id: <your user or workspace id>`, so each of your users has their own accounts, media and posts
  (without it, requests act for the owner `default`, the one the dashboard uses)

Useful with it: `ALLOWED_RETURN_ORIGINS` (where browsers may return after connecting an account), `CORS_ORIGINS`
(frontends calling the API directly), `REMOTE_MEDIA_HOSTS` (hosts `POST /api/media/from-url` may download from),
and `WEBHOOK_URL` / `WEBHOOK_SECRET` / `WEBHOOK_EVENTS`. See
[docs/PLUGIN.md](../../docs/PLUGIN.md#non-node-backends) for the webhook format and signature checks, and
[docs/openapi.yaml](../../docs/openapi.yaml) for the endpoints.

`API_TOKEN` also works with the dashboard on, for scripts.

## Scaling

By default the server keeps its data in SQLite (`DATA_DIR/post-sync.db`) and publishes in the same process. That
is right for one server. To run several:

1. Set `DATABASE_URL` to a PostgreSQL database. Tables are created on startup.
2. Give every server the same `APP_SECRET` and the same `PUBLIC_BASE_URL` (your load balancer's address), and
   mount one shared volume as `DATA_DIR` (uploaded media live in `DATA_DIR/media`).
3. Keep `WORKER=on` on the servers that should publish (one is enough; more is fine, jobs are claimed atomically
   and each account runs one job at a time). Set `WORKER=off` on API-only replicas.

On `SIGTERM` the server stops taking new jobs and gives running uploads up to 10 seconds to finish. A job cut off
by a crash is marked failed (not re-posted) once its lease expires, since the post may already be live.

## Development

`npm run dev` (from the root) runs `src/index.ts` with auto-reload against the package's TypeScript sources.
Tests are in `test/` and run with `npm test` from the root. The UI in `public/` is plain HTML/CSS/JS with no build
step.
