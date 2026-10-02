# Example: add multi-platform posting to an existing Express backend

A small "existing app" (an Express 5 server with its own login and its own frontend) that embeds the
[`post-social-media-sync`](../../packages/social-sync) package. The server side of the integration is about 200 lines:

| File | What it shows |
| --- | --- |
| [`src/app.ts`](src/app.ts) | `createApp()`: creates the engine, mounts the HTTP API at `/social` behind the app's own login, adds a host-owned route that publishes with `sync.posts.create()`, logs `target.succeeded` / `target.failed` events. |
| [`src/server.ts`](src/server.ts) | Reads env vars, listens with `server.requestTimeout = 0` (so Node doesn't cut off uploads that take longer than 5 minutes), shuts down gracefully (lets running uploads finish, closes the database). |
| [`public/index.html`](public/index.html) | A custom frontend in plain JS (no build step) that talks to the REST API with `fetch`: list and check accounts, connect Bluesky with a form and other platforms with OAuth links, upload files, validate and publish (now or scheduled), history with retry/cancel. |
| [`test/server.test.ts`](test/server.test.ts) | Smoke test against a real listening server (Bluesky is stubbed, nothing touches the network). |

## Run it

From the repository root:

```sh
npm install
npm start -w @post-sync/example-express-host
```

Open <http://localhost:4000>, log in with any name (each name is a separate user with its own accounts and posts),
connect Bluesky with your handle and an [app password](https://bsky.app/settings/app-passwords), and publish.

Other platforms need app keys. The example reads the same variables as the Post Sync dashboard (`META_APP_ID`,
`META_APP_SECRET`, `THREADS_APP_ID`, `TIKTOK_CLIENT_KEY`, `GOOGLE_CLIENT_ID`, `LINKEDIN_CLIENT_ID`, `X_CLIENT_ID`, ... see
[docs/PLATFORM_SETUP.md](../../docs/PLATFORM_SETUP.md)) from the environment or from a `.env` file in this folder.
Register this redirect URI in each platform's developer console:

```
<PUBLIC_URL>/social/oauth/<connector>/callback      e.g. http://localhost:4000/social/oauth/meta/callback
```

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `4000` | |
| `HOST` | `0.0.0.0` | |
| `PUBLIC_URL` | `http://localhost:<PORT>` | Public address of this server. Instagram photos and Threads media are downloaded by Meta from `<PUBLIC_URL>/social/media/...`, so for those it must be reachable from the internet (deploy, or use a tunnel such as cloudflared or ngrok). |
| `DATA_DIR` | `./data` | SQLite database and uploaded media. |
| `APP_SECRET` | generated into `DATA_DIR/.app-secret` | 32+ characters. Encrypts saved platform logins; never change it afterwards. |

`npm start` runs the TypeScript sources with `tsx --conditions=post-sync-source`, so the package is used straight
from `packages/social-sync/src` without building it.

## How the pieces fit

```ts
const sync = await createPostSync({
  secret,
  publicUrl: `${baseUrl}/social`, // where the handler is mounted: OAuth callbacks and media URLs live under it
  storage: sqliteStorage("./data/post-sync.db"),
  platforms: { meta: { appId, appSecret } },
});

// Your login decides who the caller is. Whatever id you return is the `ownerId`: each one only sees its own
// accounts, media and posts. Return null for "not logged in" (401).
app.use("/social", postSyncExpress(sync, { authenticate: (req) => req.user?.id }));

// Publish from your own code, e.g. when an article goes live.
await sync.posts.create(userId, { text: "New on the blog: ...", platforms: ["bluesky", "linkedin"] });

sync.on("target.succeeded", ({ target }) => notifyUser(target.ownerId, target.remoteUrl));
sync.on("target.failed", ({ target, error, willRetry }) => { /* ... */ });

// Node answers 408 to requests still running after 5 minutes by default: turn that off for big video uploads.
const server = app.listen(port);
server.requestTimeout = 0;

process.once("SIGTERM", async () => { server.close(); await sync.close(); });
```

The demo login in `src/app.ts` (a signed cookie holding a user name, no password) is marked **DEMO AUTH**. Replace it
with your real session: `req.user?.id` with Passport, `req.session.userId` with express-session, the subject of a
verified JWT, a workspace id, ... Browser OAuth links (`GET /social/connect/<connector>`) need cookie-based auth because
a navigation can't carry an `Authorization` header; with token auth, call `POST /social/connect/<connector>` instead
and send the browser to the returned `url`.

After a login the browser comes back with `?postsync=connected` or `?postsync=error`, which `public/index.html`
shows. The callback saves the accounts only for the user who started the login: it recognizes them by a cookie set
when the login started, or by their session. When it can't (token auth without that cookie, blocked third-party
cookies, a second login in another tab), it answers `?postsync=confirm&confirm=<token>` instead, and the page must
finish the login with `POST /social/connect/confirm` and `{ "confirm": "<token>" }` as the logged-in user. The client
SDK's `connect.finish()` does that. This example's page skips that step: it uses plain links, and its `SameSite=Lax`
session cookie reaches the callback, so the callback always knows who is logged in.

The full HTTP API (routes, bodies, status codes) is described in [docs/openapi.yaml](../../docs/openapi.yaml).

## Going to production

- Use PostgreSQL so several servers can share the queue: `postgresStorage(process.env.DATABASE_URL)` from
  `post-social-media-sync/postgres` (install `pg`). If several servers run the worker, `DATA_DIR/media` must be shared.
- Install `ffmpeg` on the server: it reads video sizes and converts images for platforms that need JPEG.
- Frontend on another origin? Pass `cors: { origins: ["https://app.example.com"], credentials: true }` and
  `allowedRedirectOrigins` to `postSyncExpress`.
- Outside this monorepo: `npm install post-social-media-sync express better-sqlite3` and run the server without
  `--conditions=post-sync-source` (the package then loads its compiled `dist/`).
