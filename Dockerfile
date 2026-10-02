# syntax=docker/dockerfile:1

# The ready-to-run Post Sync server (apps/dashboard) and the package it is built on (packages/social-sync).
#   docker build -t post-sync .
#   docker run -p 3000:3000 -v post-sync-data:/data --env-file .env post-sync

# ---- base: workspace manifests and a build toolchain ----
# npm runs node-gyp for better-sqlite3: a no-op when its bundled binary fits, a full compile otherwise. Both need it.
FROM node:22-bookworm-slim AS base
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
# Only the workspaces the server needs: without the examples' manifests their dependencies aren't installed.
COPY package.json package-lock.json ./
COPY packages/social-sync/package.json packages/social-sync/
COPY apps/dashboard/package.json apps/dashboard/

# ---- build: the package first (the dashboard compiles against its dist/), then the dashboard ----
FROM base AS build
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages/social-sync/tsconfig.json packages/social-sync/
COPY packages/social-sync/src packages/social-sync/src
COPY apps/dashboard/tsconfig.json apps/dashboard/
COPY apps/dashboard/src apps/dashboard/src
RUN npm run build

# ---- deps: production dependencies only ----
FROM base AS deps
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---- run ----
FROM node:22-bookworm-slim
# ffmpeg: reads video size/duration and converts images (e.g. PNG → JPEG for Instagram).
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
# node_modules/post-social-media-sync is a symlink to packages/social-sync, which resolves to its dist/ at runtime.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/packages/social-sync/package.json packages/social-sync/
COPY --from=build /app/packages/social-sync/dist packages/social-sync/dist
COPY --from=build /app/apps/dashboard/package.json apps/dashboard/
COPY --from=build /app/apps/dashboard/dist apps/dashboard/dist
COPY apps/dashboard/public apps/dashboard/public
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/dashboard/dist/index.js"]
