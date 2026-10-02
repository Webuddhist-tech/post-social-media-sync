import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createApp } from "./app.js";

if (fs.existsSync(".env")) process.loadEnvFile(".env");
const env = (name: string) => process.env[name]?.trim() ?? "";

const port = Number(env("PORT") || 4000);
const baseUrl = (env("PUBLIC_URL") || `http://localhost:${port}`).replace(/\/+$/, "");
const dataDir = path.resolve(env("DATA_DIR") || "./data");
fs.mkdirSync(dataDir, { recursive: true });

/** APP_SECRET, or one generated once and kept in the data dir (changing it makes saved logins unreadable). */
function loadSecret(): string {
  if (env("APP_SECRET")) return env("APP_SECRET");
  const file = path.join(dataDir, ".app-secret");
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(48).toString("base64url") + "\n", { mode: 0o600 });
  return fs.readFileSync(file, "utf8").trim();
}

const { app, close } = await createApp({
  baseUrl,
  secret: loadSecret(),
  dataDir,
  // Same variable names as the Post Sync dashboard. Platforms without keys stay off; Bluesky needs none.
  platforms: {
    meta: { appId: env("META_APP_ID"), appSecret: env("META_APP_SECRET") },
    threads: { appId: env("THREADS_APP_ID"), appSecret: env("THREADS_APP_SECRET") },
    tiktok: { clientKey: env("TIKTOK_CLIENT_KEY"), clientSecret: env("TIKTOK_CLIENT_SECRET") },
    linkedin: { clientId: env("LINKEDIN_CLIENT_ID"), clientSecret: env("LINKEDIN_CLIENT_SECRET") },
    google: { clientId: env("GOOGLE_CLIENT_ID"), clientSecret: env("GOOGLE_CLIENT_SECRET") },
    x: { clientId: env("X_CLIENT_ID"), clientSecret: env("X_CLIENT_SECRET") },
  },
});

const server = app.listen(port, env("HOST") || "0.0.0.0", (err?: Error) => {
  if (err) {
    console.error(err.message);
    process.exit(1);
  }
  console.log(`Example host app: ${baseUrl}  (Post Sync API at ${baseUrl}/social)`);
});
// Node answers 408 to any request still running after 5 minutes (server.requestTimeout), which cuts off large video
// uploads on slow connections. Turn that off; headersTimeout still limits how long a client may take to send headers.
server.requestTimeout = 0;

// Graceful shutdown: stop taking requests, let running uploads finish (up to 10 s), close the database.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    console.log(`${signal} received, shutting down…`);
    server.close();
    server.closeIdleConnections();
    await close();
    process.exit(0);
  });
}
