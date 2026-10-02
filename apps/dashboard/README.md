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

Settings worth knowing about besides the platform keys:

- `TRUST_PROXY`: which reverse proxy may report the visitor's address in `X-Forwarded-For`. Off by default, so the
  login lockout (5 wrong passwords lock an address out for 15 minutes) uses the connection's address. Behind Caddy,
  nginx, cloudflared or a load balancer, set it to the proxy's addresses (`loopback` for a proxy on the same machine,
  `uniquelocal` when the server runs in Docker, or IPs and CIDR ranges), or to the number of proxies when the server
  can't be reached any other way; otherwise all visitors share the proxy's address. The server logs a warning once
  when login requests carry `X-Forwarded-For` while it is off. An invalid value stops the server at startup.
- `BLUESKY_SERVERS`: the Bluesky servers users may sign in to (comma-separated URLs; default `https://bsky.social`).
  Add the address of every self-hosted server (PDS) your users connect through.
- `WEBHOOK_EVENTS`: checked at startup; an unknown event name stops the server.

**Logging out ends every dashboard session**: all browsers and devices, and other servers sharing the same
`DATA_DIR` within about 5 seconds. The cut-off time is kept in `DATA_DIR/.sessions-not-before`, so it survives
restarts. A logout request without a valid session only clears that browser's cookie. Servers that don't share
`DATA_DIR` don't see each other's logouts. `API_TOKEN` access isn't affected.

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

Connecting an account takes one more call in headless mode. Your backend calls `POST /api/connect/<connector>` and
sends the user's browser to the returned `url`. Because the browser has neither Post Sync's login cookie nor a
session, it nearly always comes back to `returnTo` with `?postsync=confirm&connector=…&confirm=<token>`, and nothing
is saved yet. Your backend then calls `POST /api/connect/confirm` with `{ "confirm": "<token>" }`, the bearer token
and the `X-Owner-Id` of the user logged in to your app (never an id taken from the URL). It answers
`{ "accounts": [...], "connector": "…" }`; a token that is unknown, used or older than 30 minutes gets 400, another
owner gets 403. The [root README](../../README.md#headless-mode-for-any-backend) has a curl example.

`API_TOKEN` also works with the dashboard on, for scripts. The dashboard itself handles `?postsync=confirm` on its
own.

## Scaling

By default the server keeps its data in SQLite (`DATA_DIR/post-sync.db`) and publishes in the same process. That
is right for one server. To run several:

1. Set `DATABASE_URL` to a PostgreSQL database. Tables are created on startup.
2. Give every server the same `APP_SECRET` and the same `PUBLIC_BASE_URL` (your load balancer's address), and
   mount one shared volume as `DATA_DIR` (uploaded media live in `DATA_DIR/media`, and the logout time in
   `DATA_DIR/.sessions-not-before`). Set `TRUST_PROXY` to your load balancer's addresses.
3. Keep `WORKER=on` on the servers that should publish (one is enough; more is fine, jobs are claimed atomically
   and each account runs one job at a time). Set `WORKER=off` on API-only replicas.

On `SIGTERM` the server stops taking new jobs and gives running uploads up to 10 seconds to finish. A job cut off
by a crash is marked failed (not re-posted) once its lease expires, since the post may already be live.

## Development

`npm run dev` (from the root) runs `src/index.ts` with auto-reload against the package's TypeScript sources.
Tests are in `test/` and run with `npm test` from the root. The UI in `public/` is plain HTML/CSS/JS with no build
step.

If you call `buildServer()` from your own code: `DashboardConfig` has a required `trustProxy` field
(`boolean | number | string[]`, what `TRUST_PROXY` parses to), `BuildOptions.sleep` also drives the waits between
webhook retries, and `src/webhooks.ts` exports `EVENT_NAMES`, the valid `WEBHOOK_EVENTS` names.
