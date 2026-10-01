import { buildApp } from "./app.js";
import { loadConfig, loadDotEnv, isPrivateBaseUrl } from "./config.js";
import { hasFfmpeg } from "./media.js";
import { CONNECTORS } from "./platforms/index.js";

async function main() {
  loadDotEnv();
  const config = loadConfig();
  const app = await buildApp({
    config,
    logger: { level: process.env.LOG_LEVEL ?? "info" },
  });

  await app.listen({ port: config.port, host: config.host });

  const ready = Object.values(CONNECTORS).filter((c) => c.isConfigured(config)).map((c) => c.name);
  app.log.info(`Dashboard: ${config.publicBaseUrl}`);
  app.log.info(`Platforms ready to connect: ${ready.join(", ")}`);
  if (isPrivateBaseUrl(config.publicBaseUrl)) {
    app.log.warn(
      "PUBLIC_BASE_URL points to a private address. Instagram photo posts and Threads media posts need a public URL (deploy, or use a tunnel such as cloudflared/ngrok).",
    );
  }
  if (!(await hasFfmpeg())) {
    app.log.warn("ffmpeg/ffprobe not found: video checks and automatic image conversion are disabled.");
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, async () => {
      app.log.info(`${signal} received, finishing running uploads (up to 10s)…`);
      await app.close();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
