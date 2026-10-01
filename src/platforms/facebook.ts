import { fileBlob, type MediaFile } from "../media.js";
import { graph, graphUrl, pollUntil } from "./meta.js";
import type { Platform, PublishContext, PublishResult } from "./types.js";

interface FacebookCredentials {
  pageAccessToken: string;
}

const MAX_VIDEO_BYTES = 1024 * 1024 * 1024; // non-resumable /videos upload limit

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

async function uploadPhoto(ctx: PublishContext, pageId: string, token: string, media: MediaFile, fields: Record<string, string>) {
  const form = new FormData();
  form.set("access_token", token);
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  form.set("source", await fileBlob(media), media.filename);
  return graph<{ id: string; post_id?: string }>(graphUrl(ctx.config, `${pageId}/photos`), {
    method: "POST",
    body: form,
    timeoutMs: 10 * 60_000,
  });
}

async function publishVideo(ctx: PublishContext, pageId: string, token: string, video: MediaFile): Promise<PublishResult> {
  const { input } = ctx;
  ctx.progress(`Uploading video (${(video.size / 1024 / 1024).toFixed(1)} MB) to Facebook…`);
  const form = new FormData();
  form.set("access_token", token);
  form.set("description", input.text);
  if (input.title) form.set("title", input.title);
  form.set("source", await fileBlob(video), video.filename);
  const res = await graph<{ id: string }>(graphUrl(ctx.config, `${pageId}/videos`, "graph-video.facebook.com"), {
    method: "POST",
    body: form,
    timeoutMs: 60 * 60_000,
  });
  const url = (await permalink(ctx, res.id, token)) ?? `https://www.facebook.com/${pageId}/videos/${res.id}`;
  return { remoteId: res.id, url, note: "Facebook may take a few minutes to process the video before it shows up." };
}

async function publishReel(ctx: PublishContext, pageId: string, token: string, video: MediaFile): Promise<PublishResult> {
  const reelsUrl = graphUrl(ctx.config, `${pageId}/video_reels`);
  ctx.progress("Starting Facebook Reel upload…");
  const start = await graph<{ video_id: string; upload_url?: string }>(reelsUrl, {
    method: "POST",
    form: { upload_phase: "start", access_token: token },
  });

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
  await graph(reelsUrl, {
    method: "POST",
    form: {
      upload_phase: "finish",
      video_id: start.video_id,
      video_state: "PUBLISHED",
      description: ctx.input.text,
      access_token: token,
    },
  });

  ctx.progress("Waiting for Facebook to process the reel…");
  await pollUntil(
    ctx.sleep,
    async () => {
      const res = await graph(graphUrl(ctx.config, start.video_id), { query: { fields: "status", access_token: token } });
      const status = res.status ?? {};
      if (status.video_status === "error" || status.processing_phase?.status === "error" || status.publishing_phase?.status === "error") {
        const why = status.processing_phase?.errors?.[0]?.message ?? status.publishing_phase?.errors?.[0]?.message ?? "processing failed";
        throw new Error(`Facebook couldn't process the reel: ${why}`);
      }
      return status.publishing_phase?.status === "complete" || status.video_status === "ready" ? true : null;
    },
    { intervalMs: 5000, timeoutMs: 20 * 60_000, what: "Facebook to process the reel" },
  );
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
        { value: "reel", label: "Reel (vertical, short)" },
      ],
      default: "video",
    },
  ],

  validate(input) {
    const errors: string[] = [];
    const video = input.media.find((m) => m.kind === "video");
    if (video && input.options.videoFormat !== "reel" && video.size > MAX_VIDEO_BYTES) {
      errors.push("Facebook video posts are limited to 1 GB here. Post it as a Reel or compress the video.");
    }
    return errors;
  },

  async publish(ctx) {
    const { pageAccessToken: token } = await ctx.credentials() as FacebookCredentials;
    const pageId = ctx.account.externalId;
    const { text, media } = ctx.input;

    if (media.length === 0) {
      ctx.progress("Posting to Facebook…");
      const res = await graph<{ id: string }>(graphUrl(ctx.config, `${pageId}/feed`), {
        method: "POST",
        form: { message: text, access_token: token },
      });
      return { remoteId: res.id, url: await permalink(ctx, res.id, token) };
    }

    if (media[0].kind === "video") {
      return ctx.input.options.videoFormat === "reel"
        ? publishReel(ctx, pageId, token, media[0])
        : publishVideo(ctx, pageId, token, media[0]);
    }

    if (media.length === 1) {
      ctx.progress("Uploading photo to Facebook…");
      const res = await uploadPhoto(ctx, pageId, token, media[0], { message: text });
      const postId = res.post_id ?? res.id;
      return { remoteId: postId, url: await permalink(ctx, postId, token) };
    }

    // Multi-photo post: upload each photo unpublished, then attach them all to one feed post.
    const ids: string[] = [];
    for (const [i, m] of media.entries()) {
      ctx.progress(`Uploading photo ${i + 1} of ${media.length}…`);
      const res = await uploadPhoto(ctx, pageId, token, m, { published: "false" });
      ids.push(res.id);
    }
    ctx.progress("Creating Facebook post…");
    const form: Record<string, string> = { message: text, access_token: token };
    ids.forEach((id, i) => (form[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id })));
    const res = await graph<{ id: string }>(graphUrl(ctx.config, `${pageId}/feed`), { method: "POST", form });
    return { remoteId: res.id, url: await permalink(ctx, res.id, token) };
  },
};
