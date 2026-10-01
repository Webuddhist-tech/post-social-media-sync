import { fileBlob, type MediaFile } from "../media.js";
import { UserError } from "../http.js";
import { graph, graphUrl, pollUntil } from "./meta.js";
import type { Platform, PublishContext } from "./types.js";

interface InstagramCredentials {
  accessToken: string;
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Instagram feed images must have an aspect ratio between 4:5 and 1.91:1. */
function aspectRatioError(m: MediaFile): string | null {
  if (m.kind !== "image" || !m.width || !m.height) return null;
  const ratio = m.width / m.height;
  if (ratio < 0.8 - 0.005 || ratio > 1.91 + 0.005) {
    return `Instagram only accepts images between 4:5 (portrait) and 1.91:1 (landscape); "${m.filename}" is ${m.width}×${m.height}. Crop it first.`;
  }
  return null;
}

async function waitForContainer(ctx: PublishContext, id: string, token: string, what: string): Promise<void> {
  await pollUntil(
    ctx.sleep,
    async () => {
      const res = await graph(graphUrl(ctx.config, id), { query: { fields: "status_code,status", access_token: token } });
      switch (res.status_code) {
        case "FINISHED":
        case "PUBLISHED":
          return true;
        case "ERROR":
        case "EXPIRED":
          throw new Error(`Instagram couldn't process the ${what}: ${res.status ?? res.status_code}`);
        default:
          return null;
      }
    },
    { intervalMs: 3000, timeoutMs: 20 * 60_000, what: `Instagram to process the ${what}` },
  );
}

/** Creates a video container and uploads the file straight to Meta (no public URL needed). */
async function createVideoContainer(
  ctx: PublishContext,
  token: string,
  video: MediaFile,
  fields: Record<string, string | undefined>,
): Promise<string> {
  const igId = ctx.account.externalId;
  const container = await graph<{ id: string; uri?: string }>(graphUrl(ctx.config, `${igId}/media`), {
    method: "POST",
    form: { ...fields, upload_type: "resumable", access_token: token },
  });
  ctx.progress(`Uploading video (${(video.size / 1024 / 1024).toFixed(1)} MB) to Instagram…`);
  const uploadUrl = container.uri ?? `https://rupload.facebook.com/ig-api-upload/${ctx.config.meta.graphVersion}/${container.id}`;
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
  return container.id;
}

async function createImageContainer(
  ctx: PublishContext,
  token: string,
  image: MediaFile,
  fields: Record<string, string | undefined>,
): Promise<string> {
  // Instagram only accepts JPEG, downloaded from a public URL.
  const jpeg = await ctx.media.jpegVariant(image, { maxBytes: MAX_IMAGE_BYTES });
  const res = await graph<{ id: string }>(graphUrl(ctx.config, `${ctx.account.externalId}/media`), {
    method: "POST",
    form: { ...fields, image_url: ctx.media.publicUrl(jpeg.file), access_token: token },
  });
  return res.id;
}

export const instagram: Platform = {
  id: "instagram",
  name: "Instagram",
  connector: "meta",
  capabilities: {
    textOnly: false,
    maxTextLength: 2200,
    maxImages: 10,
    video: true,
    mixedMedia: true,
    maxMediaItems: 10,
    needsPublicMediaUrl: "images", // videos are uploaded directly
    usesTitle: false,
  },
  options: [
    {
      key: "shareToFeed",
      label: "Also show reel in the main feed",
      type: "checkbox",
      default: true,
    },
  ],

  validate(input) {
    const errors: string[] = [];
    for (const m of input.media) {
      const err = aspectRatioError(m);
      if (err) errors.push(err);
    }
    const hashtags = input.text.match(/(^|\s)#[^\s#]+/g)?.length ?? 0;
    if (hashtags > 30) errors.push(`Instagram allows at most 30 hashtags (you have ${hashtags}).`);
    return errors;
  },

  async publish(ctx) {
    const { accessToken: token } = (await ctx.credentials()) as InstagramCredentials;
    const igId = ctx.account.externalId;
    const { text, media } = ctx.input;
    if (media.length === 0) throw new UserError("Instagram posts need at least one photo or video.");

    let containerId: string;
    let what: string;
    if (media.length === 1) {
      const m = media[0];
      if (m.kind === "video") {
        what = "reel";
        containerId = await createVideoContainer(ctx, token, m, {
          media_type: "REELS",
          caption: text,
          share_to_feed: String(ctx.input.options.shareToFeed !== false),
        });
      } else {
        what = "photo";
        ctx.progress("Sending photo to Instagram…");
        containerId = await createImageContainer(ctx, token, m, { caption: text });
      }
    } else {
      what = "carousel";
      const children: string[] = [];
      for (const [i, m] of media.entries()) {
        ctx.progress(`Preparing carousel item ${i + 1} of ${media.length}…`);
        const id =
          m.kind === "video"
            ? await createVideoContainer(ctx, token, m, { media_type: "VIDEO", is_carousel_item: "true" })
            : await createImageContainer(ctx, token, m, { is_carousel_item: "true" });
        await waitForContainer(ctx, id, token, `carousel item ${i + 1}`);
        children.push(id);
      }
      const res = await graph<{ id: string }>(graphUrl(ctx.config, `${igId}/media`), {
        method: "POST",
        form: { media_type: "CAROUSEL", children: children.join(","), caption: text, access_token: token },
      });
      containerId = res.id;
    }

    ctx.progress(`Waiting for Instagram to process the ${what}…`);
    await waitForContainer(ctx, containerId, token, what);

    ctx.progress("Publishing on Instagram…");
    const published = await graph<{ id: string }>(graphUrl(ctx.config, `${igId}/media_publish`), {
      method: "POST",
      form: { creation_id: containerId, access_token: token },
    });

    let url: string | null = null;
    try {
      const res = await graph(graphUrl(ctx.config, published.id), { query: { fields: "permalink", access_token: token } });
      url = res.permalink ?? null;
    } catch {
      // already published; the link is a nice-to-have
    }
    return { remoteId: published.id, url };
  },
};
