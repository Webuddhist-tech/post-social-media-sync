# Embedding Post Sync in your backend

This guide shows how to add multi-platform posting (Instagram, Facebook, TikTok, YouTube, LinkedIn, Threads, X,
Bluesky) to an existing backend with the `post-social-media-sync` package, and how to build your own frontend on it.
If your backend isn't Node.js, see [Non-Node backends](#non-node-backends).

- [Install](#install): entry points, [ES modules and TypeScript](#es-modules-and-typescript)
- [Concepts](#concepts): owners, `publicUrl`, OAuth redirect URIs and the login flow, Bluesky servers, media URLs,
  the worker, several servers
- [Mounting the HTTP API](#mounting-the-http-api): [Express](#express), [Fastify](#fastify), [NestJS](#nestjs),
  [Next.js](#nextjs-app-router), [Hono, Bun, Deno](#hono-bun-deno-and-other-fetch-runtimes),
  [node:http](#plain-nodehttp)
- [Options](#options): engine, handler, [logging](#logging)
- [Frontend](#frontend): [HTTP API](#http-api), [client SDK](#client-sdk) with React examples
- [Using the engine from your own code](#using-the-engine-from-your-own-code)
- [Storage](#storage)
- [Security](#security)
- [Events](#events)
- [Non-Node backends](#non-node-backends)

## Install

```bash
npm install post-social-media-sync better-sqlite3   # SQLite
npm install post-social-media-sync pg               # or PostgreSQL
```

Node.js 22.12 or newer. Install **ffmpeg** on the server if you can: Post Sync uses it to read video size and
duration, make video thumbnails, and convert images (Instagram only takes JPEG; Bluesky caps image size). Without
it, those checks and conversions are skipped or fail with a clear message.

The package has several entry points:

| Import | What |
| --- | --- |
| `post-social-media-sync` | `createPostSync`, `PostSync`, `createHandler`, `toNodeHandler`, `toWebRequest`, `sendWebResponse`, error classes, types |
| `post-social-media-sync/sqlite` | `sqliteStorage(file, { tablePrefix })` (needs `better-sqlite3`) |
| `post-social-media-sync/postgres` | `postgresStorage(poolOrConnectionString, { tablePrefix, schema, onError })` (needs `pg`) |
| `post-social-media-sync/express` | `postSyncExpress(sync, options)` middleware |
| `post-social-media-sync/fastify` | `postSyncFastify` plugin |
| `post-social-media-sync/client` | `createPostSyncClient`, `PostSyncClientError` for browsers and Node.js (no dependencies) |

### ES modules and TypeScript

The package is **ESM-only** (`"type": "module"`, no CommonJS build). Load it with `import`. A CommonJS app
(`require()`, or TypeScript compiled with `module: commonjs`) can use it too, because Node.js 22.12 and newer can
`require()` ES modules.

Which TypeScript `moduleResolution` settings find its types:

| Your `tsconfig.json` | Types found? |
| --- | --- |
| `moduleResolution: bundler` (Vite, Next.js, …) | Yes |
| `nodenext` or `node16` in an ESM project (`"type": "module"`) | Yes |
| `nodenext` in a CommonJS project | Yes, with TypeScript 5.8 or newer |
| `module: commonjs` with `node10`/`node` resolution (the default for `commonjs`, e.g. NestJS 10 projects) | Yes, through the package's `main`, `types` and `typesVersions` |
| `node16` in a CommonJS project | No: error TS1479. Switch to `nodenext` (TypeScript 5.8+) or make the project ESM. |

## Concepts

### Owners

Every account, upload and post belongs to an **`ownerId`**: your user id, or your workspace/team id if accounts are
shared in a team, and every call that reads or changes data takes it. An owner only ever sees their own connected
accounts, uploads and posts. Post Sync has no user table of its own; it
stores your id as a string. Over HTTP, your `authenticate` function returns the owner id for each request.

### `publicUrl`: where the HTTP API lives

`publicUrl` is the absolute URL where you mount the HTTP handler, as the outside world sees it, for example
`https://app.example.com/social`. Three things live under it:

- the API your frontend calls: `<publicUrl>/accounts`, `<publicUrl>/posts`, …
- the OAuth callbacks: `<publicUrl>/oauth/<connector>/callback`
- the signed media URLs: `<publicUrl>/media/<signature>/<file>`

The handler expects requests whose path starts with the path of `publicUrl` (`/social` here). If a proxy in front
of your app removes part of the path, pass `basePath` with the path your app actually sees.

The OAuth callbacks and media URLs are **public**: platforms and browsers reach them without your login. If your
app has a global "must be logged in" middleware, let `<base>/oauth/*` and `<base>/media/*` through. Only the routes
that need a user require a login. The OAuth callback also calls `authenticate`, to see whether the user who started
the login is the one logged in (see [the login flow](#oauth-redirect-uris)), but it never answers 401: no id, or an
error thrown by `authenticate`, counts as "nobody logged in" there.

### OAuth redirect URIs

Each platform except Bluesky uses OAuth. You create a developer app per platform once (see
[PLATFORM_SETUP.md](PLATFORM_SETUP.md)) and register this redirect URI in its console:

```
<publicUrl>/oauth/<connector>/callback
```

| Connector | Platforms | Keys in `platforms` |
| --- | --- | --- |
| `meta` | Facebook Pages, Instagram | `meta: { appId, appSecret, graphVersion?, loginConfigId?, extraScopes? }` |
| `threads` | Threads | `threads: { appId, appSecret }` |
| `tiktok` | TikTok | `tiktok: { clientKey, clientSecret, scopes? }` |
| `linkedin` | LinkedIn (profile, and Company Pages with `organizations: true`) | `linkedin: { clientId, clientSecret, version?, organizations? }` |
| `google` | YouTube | `google: { clientId, clientSecret }` |
| `x` | X | `x: { clientId, clientSecret? }` |
| `bluesky` | Bluesky | No app keys: users enter their handle and an app password. Optional `bluesky: { servers }` (see [Bluesky servers](#bluesky-servers)) |

`sync.redirectUri("meta")` returns the exact value, and `(await sync.describe()).connectors` lists every connector
with its `redirectUri`, whether its keys are set (`configured`), and its `developerPortal`. Print them once at
startup or show them on an admin page.

The login flow:

1. Your frontend sends the user to `<publicUrl>/connect/<connector>?returnTo=/settings/social` (a plain link, for
   cookie sessions), or calls `POST <publicUrl>/connect/<connector>` and navigates to the `url` it returns (for
   token auth, since a navigation can't carry your `Authorization` header). Both answers also set a
   `postsync_oauth` cookie in the browser: a random value, `HttpOnly`, `SameSite=Lax`, valid for 30 minutes, sent
   only to `<publicUrl path>/oauth/`.
2. The user logs in on the platform, which sends the browser to the callback.
3. The callback looks up the login by its single-use `state` (valid for 30 minutes), which says which owner started
   it. It saves the accounts for that owner only if it can tell the callback comes from them: the browser sent back
   the `postsync_oauth` cookie of that login, or that owner is logged in (your `authenticate`). It then redirects to
   `returnTo` with the result in the query string:
   - `?postsync=connected&connector=Facebook%20%26%20Instagram&count=3`: the accounts are saved.
   - `?postsync=confirm&connector=…&confirm=<token>`: the callback couldn't tell who is in this browser, so nothing
     is saved yet. The `returnTo` page must finish the login: `POST <publicUrl>/connect/confirm` with
     `{ "confirm": "<token>" }`, as the logged-in user.
   - `?postsync=error&connector=…&error=…`: the login failed, was cancelled, expired, or a different user is logged
     in here ("This login was started by a different user. Start it again from your account.").

   Every callback answer clears the cookie. `client.connect.finish()` reads the result on the `returnTo` page and
   does the confirm step for you (see [Connect accounts](#connect-accounts)).

Why the extra step: without it, someone could start a login in their own account and send the platform's login URL
to another person, whose accounts would then land in the sender's owner. When the callback can't verify the
browser, the person who started the login has to confirm it while logged in, so a stranger's login can't be
claimed. You see `postsync=confirm` when:

- your frontend authenticates with headers or tokens (a navigation doesn't carry them) and the cookie wasn't stored,
  for example because the API is on another site and the browser blocks third-party cookies;
- the user started a second login in another tab, which replaced the cookie;
- the login URL was opened in another browser, or by someone else.

The confirm token is single use and expires after 30 minutes. If the owner who confirms isn't the one who started
the login, the answer is 403 and the token is used up.

`returnTo` may be a path (resolved against `publicUrl`'s origin) or an absolute URL on an origin in
`allowedRedirectOrigins`. Without it the browser goes to `defaultReturnTo`.

### Bluesky servers

Bluesky has no OAuth app: users type their handle and an app password, and your server signs in to a Bluesky server
with them. The address of that server comes from the user (the optional *Server* field, for self-hosted accounts),
so Post Sync only signs in to servers you allow:

```ts
platforms: {
  bluesky: { servers: ["https://bsky.social", "https://pds.example.org"] }, // default: ["https://bsky.social"]
}
```

- Entries are server addresses (origins). Without a scheme, `https://` is assumed. `http://` is accepted only for
  an origin you list with `http://` (a server you run yourself). An entry with a path, query or credentials makes
  `createPostSync` throw.
- The first entry is used when the user leaves the Server field empty.
- A server that isn't on the list is refused with 400 "This Bluesky server isn't allowed here. Ask the administrator
  to add it." Anything other than a bare address gets 400 "Enter just the Bluesky server's address, like
  https://bsky.social."
- The sign-in server names the server that holds the account's data (its PDS). Post Sync only talks to it if it is
  the sign-in server itself or a public `https` host: no IP addresses in private, loopback, link-local or similar
  ranges, and no `localhost`, `*.local`, `*.internal` or single-label names. Under `https://bsky.social` it must
  also be on `*.bsky.network`. Otherwise connecting fails with "Bluesky named a server for this account that isn't
  allowed here, so nothing was sent to it."
- Bluesky requests never follow redirects. A redirect fails with
  `<host> answered with a redirect (<status>), which isn't followed.` (502 over HTTP).
- Errors from a PDS other than the sign-in server and `*.bsky.network` only show its host, the HTTP status and the
  XRPC error name, never what the server wrote.
- An account whose saved server is not (or no longer) on the list can't publish or pass a check: it fails with
  "This Bluesky account's server isn't allowed here. Reconnect it, or ask the administrator to add the server." and
  the account is marked "needs reconnect". **When upgrading**, add the servers of accounts your users connected
  through a self-hosted PDS to `servers`.

### Media and public URLs

Uploads go to `mediaDir` on disk. Each file gets a signed URL, `<publicUrl>/media/<signature>/<file>`, returned as
`url` and `thumbnailUrl` in every media object, so your frontend can show previews with a plain `<img>`.

These URLs are public on purpose. **Instagram (photos) and Threads (photos and videos) don't accept uploads: their
servers download the file from your URL.** So for those, `publicUrl` must be reachable from the internet over
HTTPS. `describe().publicMediaReachable` is `false` when `publicUrl` is `localhost` or a private address. The
signature is derived from your secret, so the URLs can't be guessed, but anyone who has one can fetch the file.
Every other platform receives the file from your server directly.

Uploads that no post uses are deleted after 24 hours by a started worker (or by `sync.worker.maintain()`, see
[the worker](#the-worker)). Deleting a post from the history deletes its files when no other post uses them.

### The worker

Creating a post stores it and queues one job per selected account. The **worker** publishes due jobs: uploads,
waits for the platform to process videos, retries temporary errors (1 min, then 5 min; `worker.maxAttempts`, default
3), and records the result. It never runs two jobs for the same account at once, even across servers.

By default `createPostSync()` starts the worker in your process (`worker.autoStart: true`). It checks for due jobs
every 2 seconds (`worker.pollIntervalMs`) and right after a post is created, runs up to `worker.concurrency` jobs at
once (default 3), refreshes long-lived logins (Threads, LinkedIn) before they expire, and cleans up unused uploads.

Use `worker: { autoStart: false }` when something else should decide where and when publishing runs:

- **A separate worker process**: web servers use `autoStart: false`; one or more worker processes call
  `sync.worker.start()`.
- **Cron or a job queue**: call `sync.worker.runDue()` on a schedule. It runs every job that is due now, waits for
  them, and returns `{ processed }`. Also call `sync.worker.maintain()` on a schedule (e.g. hourly): it does the
  upkeep a started worker does on its own timers, once, and returns `{ cleanedMedia }`.

```ts
const sync = await createPostSync({
  secret: process.env.POST_SYNC_SECRET!,
  publicUrl: "https://api.example.com/social",
  storage: postgresStorage(process.env.DATABASE_URL!),
  mediaDir: "/mnt/shared/post-sync-media",
  worker: { autoStart: false },
});

// e.g. every minute from cron, a queue consumer or a scheduled function
const { processed } = await sync.worker.runDue();
console.log(`published ${processed} job(s)`);

// e.g. hourly: refresh long-lived logins, flag expired ones, delete unused uploads older than a day
const { cleanedMedia } = await sync.worker.maintain();

await sync.close();
```

Things to know about `runDue()`:

- A video upload can take minutes. The caller must be allowed to run that long.
- Scheduled posts go out on the first run after their time, so the schedule's interval is your delay.
- `runDue()` only publishes. Without `maintain()`, tokens are still refreshed right before publishing, but a Threads
  login that isn't used for 60 days expires and must be reconnected, expired logins are only noticed when a post
  hits them, and unused uploads stay in `mediaDir`.
- Overlapping `runDue()` calls in one process (or `runDue()` next to a started worker) share `worker.concurrency`.
- The files in `mediaDir` must still be there when the job runs. Platforms with a throwaway filesystem (typical
  serverless functions) don't fit; use a server, a container with a volume, or a shared network disk.

On shutdown, call `sync.close()`: it stops the worker, waits up to 10 seconds for a claim in progress and the jobs
it started (renewing their leases meanwhile) and closes the storage. `sync.worker.stop(timeoutMs)` only stops the
worker, and `sync.worker.idle()` waits for running jobs without stopping anything. If a process dies in the middle
of a job, the job is marked failed after its lease runs out (about 2 minutes), with a message asking to check the
platform before retrying, because the post may already be live. Post Sync never re-posts such a job on its own.

Once a post is live, recording that is retried through database errors for about 15 seconds. If the database is
still down, the job stays "running" and is later reported like an interrupted job (failed, "may already be live")
rather than failed and retried. A job that already succeeded or was cancelled is never overwritten as failed, and
`sync.targets.retry()` refuses a job that has a post id on the platform.

### Several servers

To run the engine in more than one process or machine:

- Use **`postgresStorage`**. SQLite is for a single process.
- Give every process the **same `secret`** and the **same `publicUrl`** (your load balancer's address).
- Share **`mediaDir`** (a shared volume or network disk): the process that accepted an upload, the one serving
  media URLs and the one publishing may all be different.
- Start the worker on as many processes as you like. Jobs are claimed atomically with leases, and a unique index
  allows one running job per account.
- Events are emitted in the process where things happen. Subscribe in every process.
  - Where the request was handled: `post.created`, `account.connected`, `account.disconnected` and
    `target.cancelled`.
  - Where the worker runs: `target.started`, `target.progress`, `target.succeeded` and `target.failed` (including
    jobs found interrupted), and most `account.needsReconnect` events: a login rejected while publishing, while
    refreshing a token, or by the token upkeep (a started worker, or wherever you call `sync.worker.maintain()`).
  - `account.needsReconnect` also fires where the request was handled for `POST /accounts/:id/check`
    (`sync.accounts.check()`) when the login no longer works.

### Reacting to events

`sync.on(event, listener)` subscribes and returns an unsubscribe function; `sync.events.onAny((event, payload) => …)`
receives everything. Use events to notify users, update your own tables, or push live progress over WebSockets.
See [Events](#events) for the list. A listener that throws (or rejects) is logged and never breaks publishing.

## Mounting the HTTP API

The HTTP API is a standard web `Request → Response` handler (`createHandler`). Adapters plug it into Express,
Fastify and Node's `http`; fetch-based runtimes call `handler.fetch(request)` directly.

In every case you provide `authenticate`: given the request, return your user's (or workspace's) id, or `null` when
nobody is logged in (the API answers 401). Throwing an error with a 4xx `status` or `statusCode` (for example from
your auth library) answers with that status.

The id must be a non-blank string (used exactly as returned, not trimmed), or a finite number or bigint (converted
to a string). `null`, `undefined` and blank strings answer 401. Any other value (`true`/`false`, a whole user object,
an array, `NaN`, …) also answers 401, and logs one warning per kind of value: "authenticate returned a value of type
object, not an id: answering 401. Return the user's id as a string, or null." So a slip like `(req) => req.user`
can't turn every user into the same owner.

The adapters build the web `Request` from the Node.js request like this:

- scheme: `X-Forwarded-Proto` (its first value) if it is `http` or `https`, else HTTP/2's `:scheme`, else `https`
  on a TLS socket, else `http`;
- host: the `Host` header, else HTTP/2's `:authority`; a missing or malformed host becomes `localhost`;
- path: the request target as given, always as a path on that origin (a target starting with `//` stays a path).

The request's own origin counts as trusted by the [Origin check](#handler-options), so a proxy in front of your app
must pass the `Host` header through (and set `X-Forwarded-Proto` when it terminates TLS).

A request that can't become a web `Request` (for example the `TRACE` method) is passed on with `next()` by the
Express and `node:http` adapters, so your own routes still get it (without `next`: 400 `{"error":"Bad request."}`).
The Fastify plugin answers such requests 400; it only registers `GET`, `HEAD`, `POST`, `DELETE` and `OPTIONS`, so
other methods get Fastify's 404.

### Express

```ts
import express from "express";
import { createPostSync } from "post-social-media-sync";
import { postSyncExpress } from "post-social-media-sync/express";
import { sqliteStorage } from "post-social-media-sync/sqlite";

const app = express();
app.use(yourSessionMiddleware); // whatever sets req.user today

const sync = await createPostSync({
  secret: process.env.POST_SYNC_SECRET!, // 32+ random characters; never change it
  publicUrl: "https://app.example.com/social",
  storage: sqliteStorage("./data/post-sync.db"),
  mediaDir: "./data/post-sync-media",
  platforms: {
    meta: { appId: process.env.META_APP_ID!, appSecret: process.env.META_APP_SECRET! },
    google: { clientId: process.env.GOOGLE_CLIENT_ID!, clientSecret: process.env.GOOGLE_CLIENT_SECRET! },
  },
});

app.use("/social", postSyncExpress(sync, { authenticate: (req) => req.user?.id ?? null }));
const server = app.listen(3000);
server.requestTimeout = 0; // allow uploads longer than Node's default 5 minutes (see below)
process.once("SIGTERM", () => void sync.close());
```

Mount it at the path of `publicUrl`. It works before or after `express.json()`, streams uploads without buffering
them, and calls `next()` for paths it doesn't know. The second argument also takes every
[handler option](#handler-options). [examples/express-host](../examples/express-host) is a complete app.

**Large uploads:** Node's HTTP server answers 408 to any request still running after `server.requestTimeout`
(300000 ms by default), which cuts off big video uploads on slow connections. Set `server.requestTimeout = 0` (or a
large value) on the `http.Server` that `app.listen()` returns. `server.headersTimeout` (60 seconds by default) still
limits clients that are slow to send their headers. The same applies to plain `node:http` servers. Check the body
size and timeout limits of any proxy in front of your app too (for example nginx's `client_max_body_size`).

### Fastify

```ts
import Fastify from "fastify";
import { createPostSync } from "post-social-media-sync";
import { postSyncFastify } from "post-social-media-sync/fastify";
import { sqliteStorage } from "post-social-media-sync/sqlite";

const app = Fastify({ logger: true });
const sync = await createPostSync({
  secret: process.env.POST_SYNC_SECRET!,
  publicUrl: "https://api.example.com/social",
  storage: sqliteStorage("./data/post-sync.db"),
});

await app.register(postSyncFastify, {
  prefix: "/social", // the path of publicUrl
  sync,
  authenticate: (request) => getUserId(request), // your session or JWT lookup; null = 401
});
app.addHook("onClose", () => sync.close());
await app.listen({ port: 3000 });
```

The plugin reads request bodies itself (JSON and streaming uploads), only inside its own scope; your other routes
keep their parsers. Hooks registered on the parent before the plugin (cookies, sessions) still run first.

Responses go through Fastify's normal `reply`, so headers your hooks set (`@fastify/cors`, `@fastify/helmet`,
cookies from `@fastify/cookie`), your `onSend` hooks and your error handler apply to the API too, and the API's own
`Set-Cookie` headers are added to yours. Paths the API doesn't know go to Fastify's not-found handler (yours, if you
set one with `setNotFoundHandler`). The plugin registers `GET`, `HEAD`, `POST`, `DELETE` and `OPTIONS` under the
prefix. It works with `Fastify({ http2: true })` as well. The server's `requestTimeout` is 0 by default in Fastify, so
long uploads aren't cut off.

### NestJS

With the default Express platform, apply the Express middleware through a `MiddlewareConsumer`, or forward a
catch-all controller route with `toNodeHandler`. First, provide the engine:

```ts
// post-sync.module.ts
import { Module, type OnApplicationShutdown } from "@nestjs/common";
import { createPostSync, PostSync } from "post-social-media-sync";
import { postgresStorage } from "post-social-media-sync/postgres";

@Module({
  providers: [
    {
      provide: PostSync,
      useFactory: () =>
        createPostSync({
          secret: process.env.POST_SYNC_SECRET!,
          publicUrl: "https://api.example.com/social",
          storage: postgresStorage(process.env.DATABASE_URL!),
        }),
    },
  ],
  exports: [PostSync],
})
export class PostSyncModule implements OnApplicationShutdown {
  constructor(private readonly sync: PostSync) {}
  onApplicationShutdown() {
    return this.sync.close();
  }
}
```

**Middleware:**

```ts
// app.module.ts
import { Module, RequestMethod, type MiddlewareConsumer, type NestModule } from "@nestjs/common";
import { PostSync } from "post-social-media-sync";
import { postSyncExpress } from "post-social-media-sync/express";
import { PostSyncModule } from "./post-sync.module";

@Module({ imports: [PostSyncModule] })
export class AppModule implements NestModule {
  constructor(private readonly sync: PostSync) {}

  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(postSyncExpress(this.sync, { authenticate: (req) => req.session?.userId ?? null }))
      .forRoutes({ path: "social/*path", method: RequestMethod.ALL }); // NestJS 10: "social/*"
  }
}
```

Middleware runs before Nest guards, so `authenticate` must read the session or verify the JWT itself. (Calling
`app.use("/social", postSyncExpress(...))` in `main.ts` works the same way.) If you use `app.setGlobalPrefix()`,
include the prefix in `publicUrl`. For [large uploads](#express), set `app.getHttpServer().requestTimeout = 0` in
`main.ts`.

**Controller:**

```ts
// social.controller.ts
import { All, Controller, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { createHandler, PostSync, toNodeHandler } from "post-social-media-sync";
import { AuthService } from "./auth.service";

@Controller("social")
export class SocialController {
  private readonly handle: ReturnType<typeof toNodeHandler>;

  constructor(sync: PostSync, auth: AuthService) {
    this.handle = toNodeHandler(createHandler(sync), {
      // your code: the user id from the session or JWT, or null
      authenticate: (req) => auth.userIdFromRequest(req as Request),
    });
  }

  @All("*path") // NestJS 10: @All("*")
  proxy(@Req() req: Request, @Res() res: Response) {
    return this.handle(req, res);
  }
}
```

Don't put a login guard on this controller: the OAuth callback and the media URLs must work without a login, and
`authenticate` already protects everything else. If you use a global guard, exempt this controller the way your
guard allows (for example a `@Public()` decorator).

With `@nestjs/platform-fastify`, register the Fastify plugin instead:
`await app.register(postSyncFastify, { prefix: "/social", sync, authenticate })`.

### Next.js (App Router)

Create the engine once per server process, and a catch-all route handler:

```ts
// lib/post-sync.ts
import { createHandler, createPostSync, type PostSync } from "post-social-media-sync";
import { postgresStorage } from "post-social-media-sync/postgres";
import { getSession } from "./session"; // your auth

const globalForPostSync = globalThis as typeof globalThis & { postSync?: Promise<PostSync> };

// The dev server reloads modules: keep one engine on globalThis.
export const postSync = (globalForPostSync.postSync ??= createPostSync({
  secret: process.env.POST_SYNC_SECRET!,
  publicUrl: `${process.env.APP_URL}/api/social`,
  storage: postgresStorage(process.env.DATABASE_URL!),
  mediaDir: "/var/lib/myapp/post-sync-media",
}));

export const postSyncHandler = postSync.then((sync) =>
  createHandler(sync, {
    authenticate: async (request) => (await getSession(request))?.userId ?? null,
  }),
);
```

```ts
// app/api/social/[...path]/route.ts
import { postSyncHandler } from "@/lib/post-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(request: Request): Promise<Response> {
  return (await postSyncHandler).fetch(request);
}

export { handle as GET, handle as POST, handle as DELETE, handle as HEAD, handle as OPTIONS };
```

```ts
// instrumentation.ts: start the engine (and its worker) when the server boots, not on the first request
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") await import("./lib/post-sync");
}
```

Notes:

- `publicUrl` is `<your site>/api/social`, so redirect URIs are `<your site>/api/social/oauth/<connector>/callback`.
- If `middleware.ts` requires a login, exclude `/api/social/oauth` and `/api/social/media` from its matcher.
- This needs a long-running Node.js server (`next start`, a container, a VPS) with a persistent `mediaDir`. On a
  serverless host, see the [worker](#the-worker) notes.
- If the build complains about native modules (`better-sqlite3`), list them in `serverExternalPackages` in
  `next.config`.

### Hono, Bun, Deno and other fetch runtimes

`handler.fetch(request, context?)` takes a standard `Request`. Pass `{ getOwnerId }` as the second argument to
resolve the user from your framework's own context instead of `authenticate`.

```ts
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createHandler, createPostSync } from "post-social-media-sync";
import { postgresStorage } from "post-social-media-sync/postgres";

const sync = await createPostSync({
  secret: process.env.POST_SYNC_SECRET!,
  publicUrl: "https://api.example.com/social",
  storage: postgresStorage(process.env.DATABASE_URL!),
});
const handler = createHandler(sync);

const app = new Hono<{ Variables: { userId: string | null } }>();
app.use("*", yourAuthMiddleware); // sets c.set("userId", …)
app.all("/social/*", (c) => handler.fetch(c.req.raw, { getOwnerId: () => c.get("userId") }));

serve({ fetch: app.fetch, port: 3000 });
```

For a path the API doesn't know, the handler answers 404 with an `x-post-sync-unmatched` header, so you can fall
through to the rest of your app:

```ts
// Bun
Bun.serve({
  port: 3000,
  async fetch(request) {
    const response = await handler.fetch(request);
    return response.headers.has("x-post-sync-unmatched") ? yourApp(request) : response;
  },
});

// Deno (import from "npm:post-social-media-sync")
Deno.serve((request) => handler.fetch(request));
```

Post Sync is tested on Node.js 22. The engine uses `node:fs` and Node streams, and `sqliteStorage` needs the native
`better-sqlite3` module; `postgresStorage` with `pg` is the safer choice on Bun and Deno. Try it on your runtime
before relying on it.

### Plain node:http

```ts
import http from "node:http";
import { createHandler, createPostSync, toNodeHandler } from "post-social-media-sync";
import { sqliteStorage } from "post-social-media-sync/sqlite";

const sync = await createPostSync({
  secret: process.env.POST_SYNC_SECRET!,
  publicUrl: "http://localhost:3000/social",
  storage: sqliteStorage("./post-sync.db"),
});
const handle = toNodeHandler(createHandler(sync), {
  authenticate: (req) => userIdFromCookie(req.headers.cookie), // your code
});

const server = http.createServer((req, res) => void handle(req, res));
server.requestTimeout = 0; // allow uploads longer than 5 minutes (see Express above)
server.listen(3000);
```

`toNodeHandler` returns `(req, res, next?)`. With `next`, unknown paths call it (Connect-style middleware);
without, they get a 404. It also works with `node:https` and with the compatibility API of `node:http2`
(`http2.createServer` / `http2.createSecureServer`), and so do `toWebRequest()` and `sendWebResponse()`.

## Options

### `createPostSync(options)`

| Option | Default | Meaning |
| --- | --- | --- |
| `secret` | required | 32+ characters. Encrypts stored platform tokens and signs media URLs. Keep it stable (see [Security](#security)). |
| `publicUrl` | required | Absolute URL where the HTTP handler is mounted. |
| `storage` | required | `sqliteStorage(...)`, `postgresStorage(...)` or your own [`Storage`](#your-own-storage). |
| `mediaDir` | `"./post-sync-media"` | Directory for uploaded files. Shared by every process. |
| `maxUploadMb` | `4096` | Size limit per uploaded file. |
| `platforms` | `{}` | App keys per connector (see [OAuth redirect URIs](#oauth-redirect-uris)). A connector without keys is listed as not configured. `platforms.bluesky.servers` lists the [Bluesky servers](#bluesky-servers) users may sign in to (default `["https://bsky.social"]`). |
| `enabledPlatforms` | all | Only offer these platforms, e.g. `["instagram", "facebook", "youtube"]`. |
| `worker.autoStart` | `true` | Start the worker in this process. |
| `worker.concurrency` | `3` | Jobs running at once in this process (always one per account). |
| `worker.maxAttempts` | `3` | Attempts for temporary errors. |
| `worker.pollIntervalMs` | `2000` | How often a started worker looks for due jobs. |
| `logger` | console | An object with `info`, `warn`, `error` (see [Logging](#logging)), or `false` for silence. |

`createPostSync` creates the tables if needed, upgrades tables made by an earlier version (`storage.migrate()`), and
starts the worker unless told otherwise.

### Handler options

Taken by `createHandler(sync, options)`, `postSyncExpress(sync, options)` and the Fastify plugin.

| Option | Default | Meaning |
| --- | --- | --- |
| `authenticate` | – | Returns the owner id for a request, or null (401); see [Mounting](#mounting-the-http-api) for which values count as an id. Required in practice: without it every API route answers 401. Also called on the OAuth callback, where it never causes a 401 (see [the login flow](#oauth-redirect-uris)). Express gets the Express `req`, Fastify the Fastify `request`, `createHandler` the web `Request`. |
| `basePath` | path of `publicUrl` | Path the handler sees in requests, if a proxy rewrites it. (The OAuth binding cookie's `Path` still uses `publicUrl`'s path, the one browsers see.) |
| `allowedRedirectOrigins` | origin of `publicUrl` | Origins `returnTo` may point to after an OAuth login. When you set it, list `publicUrl`'s origin too if you use absolute URLs on it. Paths are always allowed. |
| `defaultReturnTo` | `/` on `publicUrl`'s origin | Where the browser goes after a login when no `returnTo` was given: a path such as `"/settings/social"` (on `publicUrl`'s origin), or an absolute http(s) URL on `publicUrl`'s origin or an `allowedRedirectOrigins` origin. Anything else makes `createHandler` (and so the Express and Fastify adapters) throw at startup. |
| `allowRemoteMedia` | off | `(url: URL) => boolean`. Enables `POST /media/from-url` for URLs it accepts. Checked again for every redirect. |
| `cors` | off | `{ origins: string[], credentials?: boolean }` for a frontend on another origin. Skip it if your framework already handles CORS (`cors` for Express, `@fastify/cors`): the adapters keep the headers it sets. Then list the frontend's origin in `allowedRedirectOrigins`, or the Origin check refuses its POST and DELETE requests. |
| `maxJsonBytes` | 1 MB | Largest JSON body. JSON bodies must be sent with the media type `application/json` (or a `+json` type); a body with another `Content-Type` answers 400. |
| `checkOrigin` | `true` | Rejects POST/DELETE requests whose browser `Origin` isn't `publicUrl`'s origin, an `allowedRedirectOrigins` or `cors.origins` entry, or the request's own origin (CSRF protection). Requests without an `Origin` header (servers, scripts) pass. |

### Logging

The `logger` option takes any object with `info`, `warn` and `error` methods, called as
`logger.error(message, ...extra)`. Messages about a failure generally carry the error's text in the message itself, for
example `worker tick failed: connection refused` or `POST /social/posts failed: <message>`, and the `Error` object is
passed as the extra argument. So a logger that ignores extra arguments, such as pino, still shows what went wrong:

```ts
import pino from "pino";

const log = pino();
const sync = await createPostSync({ /* … */ logger: log });
```

To get the error as a structured field (with its stack), map the extra argument in a small adapter:

```ts
const sync = await createPostSync({
  /* … */
  logger: { info: (msg) => log.info(msg), warn: (msg, err) => log.warn({ err }, msg), error: (msg, err) => log.error({ err }, msg) },
});
```

`console`-style loggers (the default) print the extra arguments as they are.

## Frontend

### HTTP API

Paths are relative to where you mount the handler (`publicUrl`). Request and response bodies are JSON unless
noted. Types are exported from `post-social-media-sync/client`. [openapi.yaml](openapi.yaml) has the full schema.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/platforms` | – | `Description`: platforms with `capabilities` and `options`, connectors with `configured` and `redirectUri`, `maxUploadMb`, `supportedMimeTypes`, `publicMediaReachable`, `ffmpeg` |
| GET | `/accounts` | – | `{ accounts: PublicAccount[] }` |
| GET | `/accounts/:id` | – | `{ account }` or 404 |
| DELETE | `/accounts/:id` | – | `{ ok: true }`; 409 while it has queued or running posts |
| POST | `/accounts/:id/check` | – | `{ ok, detail?, error?, needsReconnect? }`: tests the login without posting |
| GET | `/connect/:connector?returnTo=…` | – | 302 to the platform's login page (browser navigation with cookies); sets the `postsync_oauth` cookie |
| POST | `/connect/:connector` | `{ returnTo? }` | `{ url }`: send the browser there; sets the `postsync_oauth` cookie |
| POST | `/connect/confirm` | `{ confirm }` | `{ accounts: PublicAccount[], connector }`: finishes a login that came back with `postsync=confirm`; 400 if the token is missing, unknown, used or older than 30 minutes; 403 if another user started the login (the token is used up) |
| POST | `/connect/:connector/credentials` | `{ fields: { identifier, appPassword, service? } }` | 201 `{ accounts }` (Bluesky; `service` must be an [allowed server](#bluesky-servers)) |
| GET | `/oauth/:connector/callback` | – | Public. 302 to `returnTo` with `postsync=connected&connector=…&count=…`, `postsync=confirm&connector=…&confirm=…` or `postsync=error&connector=…&error=…` (see [the login flow](#oauth-redirect-uris)); clears the cookie |
| POST | `/media` | `multipart/form-data`, one or more files (up to 20) | 201 `{ media: PublicMedia[] }` |
| POST | `/media/from-url` | `{ url, filename? }` | 201 `{ media }`; 403 unless `allowRemoteMedia` accepts the URL |
| GET | `/media/:id` | – | `{ media }` |
| DELETE | `/media/:id` | – | `{ ok: true }`; 409 if a post uses it |
| GET | `/media/:signature/:file` | – | Public. The file itself (supports `Range` and `HEAD`) |
| POST | `/posts/validate` | `PostRequest` | `{ issues: TargetIssue[] }`: one entry per account; fine when `errors` is empty |
| POST | `/posts` | `PostRequest` | 201 `{ post: PublicPost }`; 400 `{ error, issues }` if an account can't take it |
| GET | `/posts?limit=20&before=…` | – | `{ posts: PublicPost[], nextBefore }`, newest first (`limit` up to 100). `nextBefore` is an opaque string cursor (null on the last page): pass it, URL-encoded, as `before` for the next page. An invalid `before` is ignored (first page). |
| GET | `/posts/:id` | – | `{ post }` |
| DELETE | `/posts/:id` | – | `{ ok: true }`: removes it from the history and drops its queued jobs (published posts stay online); 409 while publishing |
| POST | `/targets/:id/retry` | – | `{ ok: true }`; 409 unless the job failed or was cancelled (and has no post id on the platform, i.e. wasn't published) |
| POST | `/targets/:id/cancel` | – | `{ ok: true }`; 409 unless the job is queued or scheduled |

A **post** has one **target** per account. Each target has its own `status` (`queued`, `running`, `succeeded`,
`failed`, `cancelled`), `progress` text while running, `error`, and `remoteUrl` (link to the published post).

`PostRequest`:

```ts
{
  text: string;                                   // the caption ("" is fine for media-only posts)
  title?: string | null;                          // used where capabilities.usesTitle (YouTube, Facebook, LinkedIn)
  mediaIds?: string[];                            // from POST /media, in order
  targets?: { accountId: string; text?: string | null; options?: Record<string, unknown> }[];
  platforms?: PlatformId[];                       // shortcut: every active account on these platforms
  platformOptions?: { [platform]: Record<string, unknown> }; // see Description.platforms[].options
  platformText?: { [platform]: string | null };   // caption per platform
  scheduledAt?: string | number | null;           // ISO date-time or epoch ms (rounded to whole ms); omit to publish now
}
```

`scheduledAt` may be up to a minute in the past and at most 5 years ahead ("The scheduled time is more than 5 years
ahead.", 400).

Errors are `{ "error": "message" }` with a status: 400 bad input (plus `issues` for posts), 401 not logged in,
403 cross-origin request blocked or remote media not allowed, 404, 409 conflict, 413 body too large, 502 the
platform's API failed, 500 anything else. The messages are written for end users.

### Client SDK

`post-social-media-sync/client` wraps the API with types. It has no dependencies and no framework, and works in
browsers, React Native and Node.js.

```ts
import { createPostSyncClient } from "post-social-media-sync/client";

// Same origin, cookie session:
export const social = createPostSyncClient({ baseUrl: "/social" });

// API on another origin, cookie session (also set `cors: { origins, credentials: true }` on the handler):
export const socialCrossOrigin = createPostSyncClient({
  baseUrl: "https://api.example.com/social",
  credentials: "include",
});

// Token auth: headers may be an async function
export const socialWithToken = createPostSyncClient({
  baseUrl: "https://api.example.com/social",
  headers: async () => ({ Authorization: `Bearer ${await getAccessToken()}` }),
});
```

Failed calls throw `PostSyncClientError` with `message`, `status` and, for posts, `issues`.

The React examples below are short on purpose; adapt them to your components and state management.

#### Connect accounts

```tsx
import { useEffect, useState } from "react";
import { PostSyncClientError, type ConnectorDescription, type Description } from "post-social-media-sync/client";
import { social } from "./social";

export function ConnectAccounts() {
  const [description, setDescription] = useState<Description | null>(null);
  useEffect(() => void social.platforms().then(setDescription), []);
  if (!description) return null;

  return (
    <ul>
      {description.connectors
        .filter((c) => c.configured)
        .map((c) => (
          <li key={c.id}>
            {c.kind === "oauth" ? (
              // Cookie sessions: a plain link is enough. The browser comes back to returnTo.
              <a href={social.connect.url(c.id, { returnTo: "/settings/social" })}>Connect {c.name}</a>
            ) : (
              <CredentialsForm connector={c} />
            )}
          </li>
        ))}
    </ul>
  );
}

// Token auth instead: a navigation can't carry your header, so ask for the URL first.
// <button onClick={() => social.connect.redirect(c.id, { returnTo: window.location.href })}>Connect {c.name}</button>

function CredentialsForm({ connector }: { connector: ConnectorDescription }) {
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    try {
      await social.connect.withCredentials(connector.id, fields);
      setError(null);
    } catch (err) {
      setError(err instanceof PostSyncClientError ? err.message : String(err));
    }
  }

  return (
    <form onSubmit={onSubmit}>
      {connector.credentialFields?.map((f) => (
        <label key={f.key}>
          {f.label}
          <input name={f.key} type={f.type} placeholder={f.placeholder} required={f.required} />
        </label>
      ))}
      <button>Connect {connector.name}</button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
```

On the `returnTo` page, finish the login once with `social.connect.finish()` and clean up the URL. It reads the
`postsync`, `connector`, `count`, `error` and `confirm` parameters. For `postsync=confirm` (the callback couldn't
tie the login to this browser, see [the login flow](#oauth-redirect-uris)) it calls `POST /connect/confirm` as the
logged-in user and resolves to status `"connected"`. So it resolves to `"connected"` or `"error"`, or to null when
the page wasn't opened by a login, and throws a `PostSyncClientError` (with `status` 400, 401 or 403, for example)
when confirming fails.

```tsx
useEffect(() => {
  const search = location.search;
  // Clean up first: the confirm token is single use (and React's StrictMode runs effects twice in development).
  history.replaceState(null, "", location.pathname + location.hash);
  social.connect
    .finish(search) // null if this page wasn't opened by a login
    .then((result) => {
      if (!result) return;
      if (result.status === "connected") toast(`Connected ${result.count} account(s): ${result.connector}`);
      else toast.error(result.error ?? "Connecting failed.");
    })
    .catch((err) => toast.error(err.message)); // confirming failed, e.g. another user is logged in
}, []);
```

The lower-level pieces: `social.connect.parseResult(search?)` only reads the parameters (status `"connected"`,
`"confirm"` with a `confirm` token, or `"error"`), and `social.connect.confirm(token)` finishes a confirm and returns
the connected `PublicAccount[]`.

List accounts with `social.accounts.list()`. An account with `status: "needs_reauth"` must be connected again
(its `statusMessage` says why); connecting the same account again updates it. `social.accounts.check(id)` tests a
login without posting, and `social.accounts.remove(id)` disconnects.

#### Upload with progress

```tsx
function MediaPicker({ onUploaded }: { onUploaded: (ids: string[]) => void }) {
  const [progress, setProgress] = useState<number | null>(null);

  async function onChange(event: React.ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])];
    if (!files.length) return;
    setProgress(0);
    try {
      const media = await social.media.upload(files, { onProgress: setProgress });
      onUploaded(media.map((m) => m.id));
    } finally {
      setProgress(null);
    }
  }

  return (
    <>
      <input type="file" multiple accept="image/*,video/*" onChange={onChange} />
      {progress !== null && <progress value={progress} />}
    </>
  );
}
```

`onProgress` receives a fraction from 0 to 1 (it uses `XMLHttpRequest`, so it works in browsers). Pass `signal`
to cancel. Each returned media object has `url` and `thumbnailUrl` for previews, `kind`, `width`, `height` and
`duration`.

#### Composer

`social.platforms()` describes what each platform accepts, so your UI doesn't hard-code rules:

- `platforms[].capabilities`: `textOnly`, `maxTextLength`, `maxImages`, `video`, `mixedMedia`, `maxMediaItems`,
  `needsPublicMediaUrl`, `usesTitle`
- `platforms[].options`: per-platform settings to render as form fields (`select` with `choices`, `checkbox`,
  `text`), with `default`, `help`, and `remember: false` for choices your UI must not pre-fill next time (TikTok
  requires its users to pick privacy and interaction settings for every post)

Check the post as the user types, then create it:

```tsx
import type { PostRequest, TargetIssue } from "post-social-media-sync/client";

const request: PostRequest = {
  text,
  title,
  mediaIds,
  targets: selectedAccountIds.map((accountId) => ({ accountId })),
  platformOptions, // e.g. { youtube: { privacyStatus: "unlisted" }, tiktok: { privacyLevel: "SELF_ONLY" } }
  scheduledAt: scheduleAt ? scheduleAt.toISOString() : null,
};

// Debounce this while typing. One entry per account, with the caption length as that platform counts it.
const issues: TargetIssue[] = await social.posts.validate(request);
const blocking = issues.filter((i) => i.errors.length > 0); // show these next to each account

async function publish() {
  try {
    const post = await social.posts.create(request);
    navigate(`/posts/${post.id}`);
  } catch (err) {
    if (err instanceof PostSyncClientError && err.issues) setIssues(err.issues);
    else throw err;
  }
}
```

#### History with live status

```tsx
import type { PublicPost } from "post-social-media-sync/client";

function History() {
  const [posts, setPosts] = useState<PublicPost[]>([]);

  useEffect(() => {
    let stopped = false;
    async function load() {
      const page = await social.posts.list({ limit: 20 });
      if (stopped) return;
      setPosts(page.posts);
      const busy = page.posts.some((p) => p.targets.some((t) => t.status === "queued" || t.status === "running"));
      setTimeout(load, busy ? 2000 : 15000); // poll quickly only while something is publishing
    }
    void load();
    return () => {
      stopped = true;
    };
  }, []);

  return posts.map((post) => (
    <article key={post.id}>
      <p>{post.text}</p>
      {post.targets.map((t) => (
        <div key={t.id}>
          {t.accountName} ({t.platform}): {t.status} {t.progress}
          {t.remoteUrl && <a href={t.remoteUrl}>View</a>}
          {t.error && <span role="alert">{t.error}</span>}
          {t.status === "failed" && <button onClick={() => social.targets.retry(t.id)}>Retry</button>}
          {t.status === "queued" && <button onClick={() => social.targets.cancel(t.id)}>Cancel</button>}
        </div>
      ))}
    </article>
  ));
}
```

For more pages, pass the previous page's `nextBefore` (an opaque string, `null` on the last page) as `before`:
`social.posts.list({ limit: 20, before: page.nextBefore })`. Instead of polling you can push [events](#events) to
the browser over your own WebSocket or server-sent events.

## Using the engine from your own code

Everything the HTTP API does is available as methods, so your own routes, jobs and scripts can post without HTTP.
Every method takes the owner id first.

```ts
// `sync` is the engine from createPostSync(); `userId` is your user's id.

// Media from a file, a buffer (Uint8Array), or a URL you trust
const video = await sync.media.fromFile(userId, "/srv/renders/episode-12.mp4");
const cover = await sync.media.fromBuffer(userId, pngBytes, "cover.png");
const clip = await sync.media.fromUrl(userId, "https://my-bucket.s3.amazonaws.com/clip.mp4", {
  allow: (url) => url.hostname === "my-bucket.s3.amazonaws.com", // also checked for redirects
});

// Optional dry run: one entry per account, with the problems it found
const issues = await sync.posts.validate(userId, {
  text: "Episode 12 is out!",
  mediaIds: [video.id],
  platforms: ["youtube"],
});
if (issues.some((i) => i.errors.length > 0)) console.log(issues);

// Create: queues one job per account. Throws a UserError (with `issues`) if an account can't take the post.
const post = await sync.posts.create(userId, {
  text: "Episode 12 is out! #podcast",
  title: "Episode 12: Slow mornings",
  mediaIds: [video.id],
  platforms: ["youtube", "tiktok", "instagram"],
  platformOptions: {
    youtube: { privacyStatus: "public" },
    tiktok: { privacyLevel: "SELF_ONLY" },
  },
  scheduledAt: "2026-10-05T07:00:00Z",
});

sync.on("target.succeeded", ({ target }) => {
  console.log(`${target.accountName} published: ${target.remoteUrl}`);
});
```

| Namespace | Methods |
| --- | --- |
| `sync.accounts` | `list(ownerId)`, `get(ownerId, id)`, `remove(ownerId, id)` → `"deleted" \| "not_found" \| "busy"`, `check(ownerId, id)` |
| `sync.connect` | `start(ownerId, connector, { returnTo?, binding? })` → `{ url }`, `complete(connector, query, { binding?, ownerId? })` → `ConnectCompletion` and `confirm(ownerId, confirmToken)` → `{ accounts, connector, returnTo }` (used by the callback and confirm routes), `withCredentials(ownerId, connector, fields)` |
| `sync.media` | `upload(ownerId, { stream, filename, mimeType })`, `fromFile`, `fromBuffer`, `fromUrl`, `get`, `remove` → `"deleted" \| "not_found" \| "in_use"` |
| `sync.posts` | `validate`, `create`, `list(ownerId, { limit, before })` (`before`: the previous page's `nextBefore` string), `get`, `remove` → `"deleted" \| "not_found" \| "running"` |
| `sync.targets` | `retry(ownerId, id)`, `cancel(ownerId, id)` → `boolean` |
| `sync.worker` | `start()`, `stop(timeoutMs?)`, `runDue()` → `{ processed }`, `maintain()` → `{ cleanedMedia }`, `idle()`, `isRunning()` |
| `sync` | `describe()`, `redirectUri(connector)`, `on(event, listener)`, `events`, `close()` |

Validation and "not allowed" errors are thrown as `UserError` (with a message meant for end users), expired logins
as `AuthError`, and platform API failures as `ApiError`. All three are exported.

`connect.start()` trusts `returnTo` as given; validate it yourself if it comes from a browser (the HTTP handler
does).

**Your own OAuth routes.** The HTTP handler already does all of this; you only need it if you serve the login
routes yourself:

- `connect.start(ownerId, connector, { returnTo, binding })`: `binding` is an opaque string tied to the browser that
  starts the login. The handler stores the SHA-256 hex of a random value it puts in an `HttpOnly` cookie.
- `connect.complete(connector, query, { binding, ownerId })` returns a `ConnectCompletion` (exported type):
  `{ status: "connected", ownerId, accounts, returnTo, connector }` when `binding` equals the one given to
  `start()` or `ownerId` (the logged-in user, if any) is the owner who started the login; otherwise
  `{ status: "confirm", confirmToken, returnTo, connector }`, and nothing is saved yet. It throws a `ConnectError`
  (with `returnTo` and `connector`) when the login failed, expired, or `ownerId` is a different owner. Pass neither
  and every login comes back as `"confirm"`.
- `connect.confirm(ownerId, confirmToken)` finishes a `"confirm"` login for the logged-in owner. It throws a
  `UserError` when the token is missing, unknown, used or older than 30 minutes; one with `status` 403 when
  `ownerId` isn't the owner who started the login (the token is used up); and one with `status` 502 (the platform's
  API failed) or 400 (for example a rejected code) when the code exchange fails. The token is single use either way.

## Storage

### SQLite

```ts
import { sqliteStorage } from "post-social-media-sync/sqlite";

const storage = sqliteStorage("./data/post-sync.db", { tablePrefix: "postsync_" }); // or ":memory:" in tests
```

Good for a single server process. It can share a database file with your own tables: the tables are prefixed
(`postsync_` by default).

### PostgreSQL

```ts
import pg from "pg";
import { postgresStorage } from "post-social-media-sync/postgres";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL }); // your existing pool
const storage = postgresStorage(pool, { tablePrefix: "social_", schema: "app" });
// or: postgresStorage(process.env.DATABASE_URL!), which creates (and closes) its own pool
```

Safe for several processes and servers. Pass the pool your app already has to share connections; Post Sync then
leaves it open on `sync.close()`. `schema` puts the tables in a Postgres schema (default: your `search_path`).
Tables (and the schema) are created on startup if missing, so the database user needs that right, at least on the
first run.

When an idle connection drops (database restart, failover, a proxy's idle timeout), `pg` emits an `error` event on
the pool, and an unheard `error` event crashes Node.js:

- A pool created from a connection string has a listener: it calls the `onError` option, by default
  `console.error("[post-sync] PostgreSQL connection error: <message>", err)`. The pool replaces the connection by
  itself.

  ```ts
  postgresStorage(process.env.DATABASE_URL!, { onError: (err) => logger.warn({ err }, "postgres connection lost") });
  ```

- A pool you pass in needs its own listener: `pool.on("error", (err) => …)`.

### Your own storage

Implement the `Storage` interface (exported with its row types `AccountRow`, `MediaRow`, `PostRow`, `TargetRow`,
`OAuthStateRow`) to use another database. The two built-in ones in `packages/social-sync/src/storage/` are the
reference. The parts that need care:

- `claimDueTargets(limit, now, leaseUntil)` must be atomic across processes: claim queued targets with
  `run_at <= now`, at most one per account, none for an account that already has a running target; mark them
  running, increment `attempts`, set `lease_until`.
- `failExpiredLeases(now, message)` marks running targets whose lease expired as failed and returns them.
- `failTarget(id, error, retryAt)` only updates a target whose status is `running` (never one that succeeded, was
  cancelled or was already failed elsewhere) and returns `true` if it did.
- `retryTarget(ownerId, id)` only queues a failed or cancelled target whose `remote_id` is null (one with a remote id
  was published).
- `deletePostIfIdle(ownerId, id)` deletes a post and its targets unless one of them is running, and returns
  `"deleted"`, `"running"` or `"not_found"`. The check and the delete must be atomic with respect to
  `claimDueTargets`, so no job starts on a post being deleted.
- `listPosts(ownerId, limit, before?: { createdAt: number; id: string })` returns posts ordered by
  `created_at DESC, id DESC`. With `before`, return only the rows after it in that order:
  `created_at < before.createdAt OR (created_at = before.createdAt AND id < before.id)`. An empty `before.id` means
  "created before `before.createdAt`".
- `setAccountStatus(id, status, message)` returns `true` only when the status changed, decided atomically (of
  several concurrent calls setting the same status, only one gets `true`; for example
  `UPDATE … WHERE id = ? AND status <> ?`). When the status is already the same, still update the message. The
  engine emits `account.needsReconnect` only on `true`.
- `saveOAuthState(row)` and `takeOAuthState(state, notOlderThan)` store and return every `OAuthStateRow` field,
  including `binding` and `callback_query` (both `string | null`). `takeOAuthState` returns and deletes the row in
  one step (single use). Logins waiting for confirmation are stored as rows whose `state` is `"confirm:"` + a SHA-256
  hex.
- Methods that take `ownerId: string | null` treat `null` as "any owner" (used by the worker only).

If you wrote a `Storage` for an earlier version: `deletePost` was replaced by `deletePostIfIdle`;
`setAccountStatus` and `failTarget` now return a boolean; `listPosts` takes the `{ createdAt, id }` cursor instead of
a number; `retryTarget` must skip targets with a remote id; and the OAuth state table needs the `binding` and
`callback_query` columns (`migrate()` should add them to an existing table).

## Security

- **`authenticate` decides who is calling.** Return the id only for a valid session or token. Every API route
  except the OAuth callback and media files needs it; without it they answer 401.
- **OAuth logins are tied to the user who started them.** The callback saves accounts only for a browser that
  carries that login's `postsync_oauth` cookie, or while that same user is logged in; a different logged-in user is
  refused, and anything else waits for the starter to confirm it (`POST /connect/confirm`). So a login URL sent to
  someone else can't put their accounts into the sender's owner. Your `returnTo` page must call the confirm step only
  as the user who is logged in on your side, never for an owner taken from the URL.
- **CSRF**: with cookie sessions, the handler rejects POST and DELETE requests whose browser `Origin` header isn't
  trusted (`checkOrigin`, on by default). Keep your session cookie `SameSite=Lax` or stricter. If your frontend is
  on another origin, add it to `cors.origins` or `allowedRedirectOrigins`.
- **Open redirects**: `returnTo` must be a path or an absolute URL on `allowedRedirectOrigins`. Keep that list to
  your own frontends.
- **SSRF**: `POST /media/from-url` makes your server download a URL. It is off unless `allowRemoteMedia` accepts
  the URL; allow only hosts you control (your bucket or CDN), and never all URLs. The check also runs for every
  redirect. The same goes for `sync.media.fromUrl(…, { allow })` in your own code. Bluesky sign-ins only go to
  [allowed servers](#bluesky-servers) (`platforms.bluesky.servers`), and the server the account's data lives on
  must be a public `https` host.
- **Tokens at rest**: platform tokens are encrypted with AES-256-GCM under a key derived from `secret`. Keep the
  secret with your other secrets (not in code) and back it up separately from the database: the database alone
  doesn't reveal the tokens, and without the secret they are lost.
- **Changing the secret** makes every saved login unreadable (all accounts must be connected again) and changes
  every media URL. Don't rotate it casually; if you must, plan for reconnecting.
- **Media URLs** are public but unguessable. Anyone with a link can fetch that file, so don't upload what must stay
  private. Unused uploads are deleted after 24 hours by a started worker (or `sync.worker.maintain()`).
- **Owner ids** come from your `authenticate` only; a browser can't choose them.

## Events

```ts
sync.on("target.failed", ({ target, error, willRetry }) => {
  if (!willRetry) notifyUser(target.ownerId, `${target.accountName}: ${error}`);
});
sync.on("account.needsReconnect", ({ account, message }) => notifyUser(account.ownerId, message));
const off = sync.events.onAny((event, payload) => console.log(event, payload));
off(); // unsubscribe
```

| Event | Payload | When |
| --- | --- | --- |
| `post.created` | `{ post: PublicPost }` | A post was created (one target per account, all queued). |
| `target.started` | `{ target: PublicTarget }` | A job started publishing. |
| `target.progress` | `{ target, message }` | Progress while publishing ("Uploading to TikTok (2/5)…", "Waiting for TikTok to process the video…"). Frequent. |
| `target.succeeded` | `{ target }` | Published. `target.remoteUrl` links to the post. |
| `target.failed` | `{ target, error, willRetry, retryAt }` | Failed. `willRetry` is true when it will be retried at `retryAt` (epoch ms). |
| `target.cancelled` | `{ target }` | A queued job was cancelled. |
| `account.connected` | `{ accounts: PublicAccount[] }` | Accounts were connected (or reconnected). |
| `account.disconnected` | `{ account: PublicAccount }` | An account was removed. |
| `account.needsReconnect` | `{ account, message }` | A login expired or was revoked. The user must connect it again. Sent once when the account changes from active to "needs reconnect", not again for every failed attempt. |

Every payload carries the owner id (`post.ownerId`, `target.ownerId`, `account.ownerId`).

## Non-Node backends

If your backend is Python, PHP, Go, Ruby, Java or anything else, run the Post Sync server headless next to it
instead of embedding the package:

```bash
DASHBOARD=off
API_TOKEN=a-long-random-token-for-your-backend
PUBLIC_BASE_URL=https://social.example.com
ALLOWED_RETURN_ORIGINS=https://app.example.com
WEBHOOK_URL=https://app.example.com/hooks/post-sync
WEBHOOK_SECRET=another-long-random-secret
# Behind a reverse proxy on the same host (see .env.example):
# TRUST_PROXY=loopback
```

Your backend calls `<PUBLIC_BASE_URL>/api/...` (the same [HTTP API](#http-api), mounted at `/api`) with
`Authorization: Bearer <API_TOKEN>` and `X-Owner-Id: <your user id>` (1-200 characters: letters, digits and
`. _ : @ | -`). Keep the token on your servers: it can act for every owner. Redirect URIs are
`<PUBLIC_BASE_URL>/api/oauth/<connector>/callback`. The [README](../README.md#headless-mode-for-any-backend) has a
curl walkthrough and [openapi.yaml](openapi.yaml) describes every endpoint, so you can generate a client.

To connect an account:

1. Your backend calls `POST /api/connect/<connector>` with `{ "returnTo": "https://app.example.com/settings" }`
   and redirects the user's browser to the returned `url`.
2. After the login, the browser lands on `returnTo`. Because the login was started by your backend, the user's
   browser carries neither Post Sync's login cookie nor a session, so the result is nearly always
   `?postsync=confirm&connector=…&confirm=<token>`: nothing is saved yet. (`?postsync=error&…` if the login failed;
   `?postsync=connected&…` is possible too, and needs nothing more.)
3. Your `returnTo` page passes the token to your backend, which calls `POST /api/connect/confirm` with
   `{ "confirm": "<token>" }`, the bearer token and the `X-Owner-Id` of **the user who is logged in to your app
   right now** (not an id taken from the URL). The answer is `{ "accounts": [...], "connector": "…" }`. A different
   owner gets 403, and a token that is unknown, used or older than 30 minutes gets 400.

### Webhooks

With `WEBHOOK_URL` set, the server POSTs each [event](#events) to it as JSON:

```json
{
  "id": "5f0c2a9e-…",
  "event": "target.succeeded",
  "data": {
    "target": { "id": "…", "postId": "…", "ownerId": "user_42", "platform": "youtube", "status": "succeeded", "remoteUrl": "https://…", "…": "…" }
  },
  "createdAt": 1790000000000
}
```

`data` is the event's payload from the [table above](#events), with complete objects.

Headers:

| Header | Value |
| --- | --- |
| `X-Post-Sync-Event` | the event name |
| `X-Post-Sync-Delivery` | the delivery id (same as `id`; the same on retries) |
| `X-Post-Sync-Timestamp` | Unix time in seconds when this attempt was signed |
| `X-Post-Sync-Signature` | `sha256=` + hex HMAC-SHA256 of `"<timestamp>.<raw body>"` with `WEBHOOK_SECRET` (only when the secret is set) |

`WEBHOOK_EVENTS` limits which events are sent (comma-separated event names from the [table above](#events),
case-sensitive; default: all except `target.progress`). An unknown name stops the server at startup with
"WEBHOOK_EVENTS has unknown events: … Valid events: …", even when `WEBHOOK_URL` isn't set. Answer with any 2xx
status. Failed deliveries (network errors, 5xx, 408, 429) are retried 3 more times over about 20
seconds; other 4xx answers aren't retried, and redirects aren't followed. A delivery can arrive more than once, so
ignore ids you have already handled. Always verify the signature over the **raw** body, before parsing it.

Node.js (Express; register the route before a global `express.json()`, which would consume the raw body):

```ts
import crypto from "node:crypto";
import express from "express";

const app = express();
const SECRET = process.env.WEBHOOK_SECRET!;

function verify(rawBody: Buffer, timestamp: string | undefined, signature: string | undefined): boolean {
  if (!timestamp || !signature) return false;
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!(age <= 300)) return false; // older than 5 minutes, or not a number
  const expected = "sha256=" + crypto.createHmac("sha256", SECRET).update(`${timestamp}.${rawBody}`).digest("hex");
  return signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

app.post("/hooks/post-sync", express.raw({ type: "application/json" }), (req, res) => {
  if (!verify(req.body, req.get("x-post-sync-timestamp"), req.get("x-post-sync-signature"))) {
    res.sendStatus(401);
    return;
  }
  const { id, event, data } = JSON.parse(req.body.toString("utf8"));
  // e.g. event === "target.succeeded": data.target.ownerId, data.target.remoteUrl
  res.sendStatus(204);
});
```

Python (Flask):

```python
import hashlib, hmac, os, time
from flask import Flask, abort, request

app = Flask(__name__)
SECRET = os.environ["WEBHOOK_SECRET"].encode()

def verify(raw_body: bytes, timestamp: str, signature: str) -> bool:
    if not timestamp.isdigit() or abs(time.time() - int(timestamp)) > 300:
        return False
    expected = "sha256=" + hmac.new(SECRET, timestamp.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(signature, expected)

@app.post("/hooks/post-sync")
def post_sync_webhook():
    raw = request.get_data()
    timestamp = request.headers.get("X-Post-Sync-Timestamp", "")
    signature = request.headers.get("X-Post-Sync-Signature", "")
    if not verify(raw, timestamp, signature):
        abort(401)
    payload = request.get_json()
    # payload["event"], payload["data"], payload["id"]
    return "", 204
```
