import { ApiError, publishStep, uncertainOutcome } from "../http.js";
import { fileBlob, type MediaFile } from "../media.js";
import { pollUntil } from "./common.js";
import { graph, graphUrl } from "./meta.js";
import type { Platform, PublishContext, PublishResult } from "./types.js";

interface FacebookCredentials {
  pageAccessToken: string;
}

const MAX_VIDEO_BYTES = 1024 * 1024 * 1024; // non-resumable /videos upload limit…
const MAX_VIDEO_SECONDS = 20 * 60; // …which also caps duration
const MAX_PHOTO_BYTES = 4_000_000; // Page photos must be under 4 MB
const PERMISSION_HINT =
  "Check that your role on this Page allows creating content and that you allowed all permissions when connecting Facebook.";

function absolutize(permalink: string | undefined | null): string | null {
  if (!permalink) return null;
  return permalink.startsWith("http") ? permalink : `https://www.facebook.com${permalink.startsWith("/") ? "" : "/"}${permalink}`;
}

async function permalink(ctx: PublishContext, id: string, token: string): Promise<string | null> {
  try {
    const res = await graph(graphUrl(ctx.config, id), { query: { fields: "permalink_url", access_token: token } });
    return absolutize(res.permalink_url);
  } catch {
    return null; // the post is live; a missing link isn't worth failing over
  }
}

/** Page photos must be JPEG/PNG/GIF/… under 4 MB: shrink big photos and convert WebP. GIFs are kept (animation). */
async function preparePhoto(ctx: PublishContext, m: MediaFile): Promise<MediaFile> {
  if (m.mime === "image/gif") return m;
  if (m.mime === "image/webp" || m.size > MAX_PHOTO_BYTES) return ctx.media.jpegVariant(m, { maxBytes: MAX_PHOTO_BYTES });
  return m;
}

async function uploadPhoto(ctx: PublishContext, pageId: string, token: string, media: MediaFile, fields: Record<string, string>) {
  const form = new FormData();
  form.set("access_token", token);
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  form.set("source", await fileBlob(media), media.filename);
  return graph<{ id: string; post_id?: string }>(
    graphUrl(ctx.config, `${pageId}/photos`),
    { method: "POST", body: form, timeoutMs: 10 * 60_000 },
    { permissionHint: PERMISSION_HINT },
  );
}

async function publishVideo(ctx: PublishContext, pageId: string, token: string, video: MediaFile): Promise<PublishResult> {
  const { input } = ctx;
  ctx.progress(`Uploading video (${(video.size / 1024 / 1024).toFixed(1)} MB) to Facebook…`);
  const form = new FormData();
  form.set("access_token", token);
  form.set("description", input.text);
  if (input.title) form.set("title", input.title);
  form.set("source", await fileBlob(video), video.filename);
  // The upload itself publishes the video, so a lost response must not lead to a second upload.
  const res = await publishStep("Facebook", () =>
    graph<{ id: string }>(
      graphUrl(ctx.config, `${pageId}/videos`),
      { method: "POST", body: form, timeoutMs: 60 * 60_000 },
      { permissionHint: PERMISSION_HINT },
    ),
  );
  const url = (await permalink(ctx, res.id, token)) ?? `https://www.facebook.com/${pageId}/videos/${res.id}`;
  return { remoteId: res.id, url, note: "Facebook may take a few minutes to process the video before it shows up." };
}

async function publishReel(ctx: PublishContext, pageId: string, token: string, video: MediaFile): Promise<PublishResult> {
  const reelsUrl = graphUrl(ctx.config, `${pageId}/video_reels`);
  ctx.progress("Starting Facebook Reel upload…");
  const start = await graph<{ video_id: string; upload_url?: string }>(
    reelsUrl,
    { method: "POST", form: { upload_phase: "start", access_token: token } },
    { permissionHint: PERMISSION_HINT },
  );

  ctx.progress(`Uploading reel (${(video.size / 1024 / 1024).toFixed(1)} MB)…`);
  const uploadUrl = start.upload_url ?? `https://rupload.facebook.com/video-upload/${ctx.config.meta.graphVersion}/${start.video_id}`;
  await graph(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `OAuth ${token}`,
      offset: "0",
      file_size: String(video.size),
      "Content-Type": "application/octet-stream",
    },
    body: await fileBlob(video),
    timeoutMs: 60 * 60_000,
  });

  ctx.progress("Publishing reel…");
  await publishStep("Facebook", () =>
    graph(reelsUrl, {
      method: "POST",
      form: {
        upload_phase: "finish",
        video_id: start.video_id,
        video_state: "PUBLISHED",
        description: ctx.input.text,
        access_token: token,
      },
    }),
  );

  ctx.progress("Waiting for Facebook to process the reel…");
  try {
    await pollUntil(
      ctx.sleep,
      async () => {
        const res = await graph(graphUrl(ctx.config, start.video_id), { query: { fields: "status", access_token: token } });
        const status = res.status ?? {};
        const phases = [status.uploading_phase, status.processing_phase, status.publishing_phase];
        const failedPhase = phases.find((p) => p?.status === "error");
        if (["error", "expired", "upload_failed"].includes(status.video_status) || failedPhase) {
          const why = failedPhase?.errors?.[0]?.message ?? status.video_status ?? "processing failed";
          throw new Error(`Facebook couldn't process the reel: ${why}`);
        }
        const published =
          ["complete", "completed"].includes(status.publishing_phase?.status) ||
          status.publishing_phase?.publish_status === "published" ||
          status.video_status === "ready";
        return published ? true : null;
      },
      // The reel is already submitted for publishing: ride out temporary errors instead of starting over.
      { intervalMs: 5000, maxIntervalMs: 60_000, timeoutMs: 20 * 60_000, what: "Facebook to process the reel", tolerateTransientErrors: true },
    );
  } catch (err) {
    // Starting over would publish the reel a second time.
    if (err instanceof ApiError && err.retryable) throw uncertainOutcome("Facebook", err);
    throw err;
  }
  return { remoteId: start.video_id, url: `https://www.facebook.com/reel/${start.video_id}` };
}

export const facebook: Platform = {
  id: "facebook",
  name: "Facebook",
  connector: "meta",
  capabilities: {
    textOnly: true,
    maxTextLength: 63206,
    maxImages: 10,
    video: true,
    mixedMedia: false,
    needsPublicMediaUrl: false,
    usesTitle: true,
  },
  options: [
    {
      key: "videoFormat",
      label: "Post video as",
      type: "select",
      choices: [
        { value: "video", label: "Regular video post" },
        { value: "reel", label: "Reel (vertical, 3–90 s)" },
      ],
      default: "video",
    },
  ],

  validate(input) {
    const errors: string[] = [];
    const video = input.media.find((m) => m.kind === "video");
    if (video && input.options.videoFormat === "reel") {
      if (video.duration !== null && (video.duration < 3 || video.duration > 90)) {
        errors.push(`Facebook Reels must be 3–90 seconds long (this video is ${Math.round(video.duration)} s). Post it as a regular video instead.`);
      }
      if (video.width && video.height && (video.width >= video.height || video.width < 540 || video.height < 960)) {
        errors.push(`Facebook Reels must be vertical (9:16, at least 540×960); this video is ${video.width}×${video.height}.`);
      }
    } else if (video) {
      if (video.size > MAX_VIDEO_BYTES) errors.push("Facebook video posts are limited to 1 GB here. Compress or trim the video.");
      if (video.duration !== null && video.duration > MAX_VIDEO_SECONDS) {
        errors.push("Facebook video posts are limited to 20 minutes here. Trim the video.");
      }
    }
    for (const m of input.media) {
      if (m.mime === "image/gif" && m.size > MAX_PHOTO_BYTES) errors.push(`Facebook photos must be under 4 MB; "${m.filename}" is a larger GIF.`);
    }
    return errors;
  },

  async publish(ctx) {
    const { pageAccessToken: token } = (await ctx.credentials()) as FacebookCredentials;
    const pageId = ctx.account.externalId;
    const { text, media } = ctx.input;

    if (media.length === 0) {
      ctx.progress("Posting to Facebook…");
      const res = await publishStep("Facebook", () =>
        graph<{ id: string }>(
          graphUrl(ctx.config, `${pageId}/feed`),
          { method: "POST", form: { message: text, access_token: token } },
          { permissionHint: PERMISSION_HINT },
        ),
      );
      return { remoteId: res.id, url: await permalink(ctx, res.id, token) };
    }

    if (media[0].kind === "video") {
      return ctx.input.options.videoFormat === "reel"
        ? publishReel(ctx, pageId, token, media[0])
        : publishVideo(ctx, pageId, token, media[0]);
    }

    // Convert everything first so a conversion problem can't leave half-uploaded photos behind.
    const photos: MediaFile[] = [];
    for (const m of media) photos.push(await preparePhoto(ctx, m));

    if (photos.length === 1) {
      ctx.progress("Uploading photo to Facebook…");
      const res = await publishStep("Facebook", () => uploadPhoto(ctx, pageId, token, photos[0], { message: text }));
      const postId = res.post_id ?? res.id;
      return { remoteId: postId, url: await permalink(ctx, postId, token) };
    }

    // Multi-photo post: upload each photo unpublished, then attach them all to one feed post.
    const ids: string[] = [];
    for (const [i, m] of photos.entries()) {
      ctx.progress(`Uploading photo ${i + 1} of ${photos.length}…`);
      const res = await uploadPhoto(ctx, pageId, token, m, { published: "false" });
      ids.push(res.id);
    }
    ctx.progress("Creating Facebook post…");
    const form: Record<string, string> = { message: text, access_token: token };
    ids.forEach((id, i) => (form[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id })));
    const res = await publishStep("Facebook", () =>
      graph<{ id: string }>(graphUrl(ctx.config, `${pageId}/feed`), { method: "POST", form }, { permissionHint: PERMISSION_HINT }),
    );
    return { remoteId: res.id, url: await permalink(ctx, res.id, token) };
  },

  async checkConnection(ctx) {
    const { pageAccessToken: token } = (await ctx.credentials()) as FacebookCredentials;
    const page = await graph(graphUrl(ctx.config, ctx.account.externalId), { query: { fields: "id,name", access_token: token } });
    return `Connected to the Page "${page.name}".`;
  },
};
