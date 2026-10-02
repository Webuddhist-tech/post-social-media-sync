# post-social-media-sync

Publish one post to **Instagram, Facebook, TikTok, YouTube, LinkedIn, Threads, X and Bluesky** from your own
Node.js backend, through each platform's official API.

- **Multi-user**: every account, upload and post belongs to an `ownerId` (your user or workspace id); one instance
  serves all your users.
- **Account logins**: OAuth for every platform (Bluesky: app password), tokens encrypted at rest and refreshed for
  you.
- **Publishing queue**: chunked uploads, waiting for platform processing, retries for temporary errors, scheduling,
  no duplicate posts, one job per account at a time, safe across several servers.
- **Checks before posting**: caption length as each platform counts it, media rules, per-platform options.
- **HTTP API for your frontend**, as a web `Request → Response` handler with Express and Fastify adapters, plus a
  typed client SDK. Or call the engine directly from your own routes and jobs.
- **Storage**: SQLite or PostgreSQL (your existing `pg` pool), or your own.

Node.js 22.12+. ffmpeg on the server is recommended (video checks, thumbnails, image conversion).

## Install

```bash
npm install post-social-media-sync better-sqlite3   # or: pg (PostgreSQL)
```

The package is **ESM-only**. CommonJS apps can `require()` it too, since Node.js 22.12 supports loading ES modules
that way. TypeScript finds its types with `moduleResolution` `bundler`, `nodenext`/`node16` in an ESM project,
`nodenext` in a CommonJS project (TypeScript 5.8+), or `module: commonjs` with the classic `node10` resolution
(e.g. NestJS 10). `node16` in a CommonJS project fails with TS1479: use `nodenext` (TypeScript 5.8+) or ESM.

## Express quick start

```ts
import express from "express";
import { createPostSync } from "post-social-media-sync";
import { postSyncExpress } from "post-social-media-sync/express";
import { sqliteStorage } from "post-social-media-sync/sqlite";

const app = express();
app.use(yourSessionMiddleware); // sets req.user

const sync = await createPostSync({
  secret: process.env.POST_SYNC_SECRET!, // 32+ random characters; never change it
  publicUrl: "https://app.example.com/social", // where the handler is mounted
  storage: sqliteStorage("./data/post-sync.db"),
  platforms: {
    meta: { appId: process.env.META_APP_ID!, appSecret: process.env.META_APP_SECRET! },
    google: { clientId: process.env.GOOGLE_CLIENT_ID!, clientSecret: process.env.GOOGLE_CLIENT_SECRET! },
  },
});

app.use("/social", postSyncExpress(sync, { authenticate: (req) => req.user?.id ?? null }));
const server = app.listen(3000);
server.requestTimeout = 0; // Node otherwise answers 408 to uploads that take longer than 5 minutes
```

Register `https://app.example.com/social/oauth/<connector>/callback` as the redirect URI in each platform's developer
console (`sync.redirectUri("meta")` gives the exact value). Instagram photos and Threads media are downloaded by the
platform from `publicUrl`, so it must be reachable from the internet.

Fastify: `await app.register(postSyncFastify, { prefix: "/social", sync, authenticate })` from
`post-social-media-sync/fastify`; responses go through Fastify's reply, so your hooks (e.g. `@fastify/cors`) apply.
Next.js, Hono and other fetch runtimes: `createHandler(sync, { authenticate }).fetch(request)`.

Bluesky users sign in with an app password on a server you allow: `platforms: { bluesky: { servers: [...] } }`
(default `["https://bsky.social"]`; add self-hosted servers there).

## Client quick start

```ts
import { createPostSyncClient } from "post-social-media-sync/client";

const social = createPostSyncClient({ baseUrl: "/social" });

const { connectors, platforms } = await social.platforms(); // what's configured, each platform's rules and options
const href = social.connect.url("meta", { returnTo: "/settings" }); // a plain "Connect" link (cookie sessions)
// On the returnTo page: the login's result, after finishing it if it came back with ?postsync=confirm
const result = await social.connect.finish(); // status "connected" | "error", or null
const accounts = await social.accounts.list();

const media = await social.media.upload(fileInput.files![0], { onProgress: (f) => console.log(f) });
const post = await social.posts.create({
  text: "Hello from my app #launch",
  mediaIds: [media[0].id],
  targets: accounts.map((a) => ({ accountId: a.id })),
});
// post.targets[i].status: queued → running → succeeded (remoteUrl) or failed (error)
```

## Without HTTP

```ts
const video = await sync.media.fromFile(userId, "/srv/renders/episode-12.mp4");
await sync.posts.create(userId, {
  text: "Episode 12 is out!",
  mediaIds: [video.id],
  platforms: ["youtube", "tiktok"], // every connected account on these platforms
  platformOptions: { tiktok: { privacyLevel: "SELF_ONLY" } },
  scheduledAt: "2026-10-05T07:00:00Z", // optional
});
sync.on("target.succeeded", ({ target }) => console.log(target.remoteUrl));
```

Publishing from cron instead of the built-in worker: `worker: { autoStart: false }`, then call
`sync.worker.runDue()` every minute and `sync.worker.maintain()` (token refresh, cleanup of unused uploads) every
hour.

## Documentation

- [Integration guide](https://github.com/Webuddhist-tech/post-social-media-sync/blob/main/docs/PLUGIN.md):
  Express, Fastify, NestJS, Next.js, Hono/Bun/Deno, the OAuth login flow, the HTTP API, the client SDK with React
  examples, the worker (cron/serverless), logging, PostgreSQL and multi-server setups, custom storage, events,
  security
- [Platform setup](https://github.com/Webuddhist-tech/post-social-media-sync/blob/main/docs/PLATFORM_SETUP.md):
  creating each platform's developer app
- [OpenAPI document](https://github.com/Webuddhist-tech/post-social-media-sync/blob/main/docs/openapi.yaml)
- [Example Express app](https://github.com/Webuddhist-tech/post-social-media-sync/tree/main/examples/express-host)
- [Post Sync server](https://github.com/Webuddhist-tech/post-social-media-sync): a ready-to-run dashboard and
  headless HTTP API built on this package, for non-Node backends

MIT license.
