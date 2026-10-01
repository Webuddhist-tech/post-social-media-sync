import { UserError } from "../http.js";
import { fileBlob, type MediaFile } from "../media.js";
import { pollUntil } from "./common.js";
import { graph, graphUrl, publishContainerOnce } from "./meta.js";
import type { Platform, PublishContext } from "./types.js";

interface InstagramCredentials {
  accessToken: string;
}

const MAX_IMAGE_BYTES = 8_000_000;
const MAX_REEL_BYTES = 300_000_000;
const PERMISSION_HINT =
  "Check that your role on the linked Facebook Page allows creating content. If that role comes from Business Manager, Meta also requires the ads_read permission: set META_EXTRA_SCOPES=ads_read and reconnect.";

/** Feed photos and carousel items must have an aspect ratio between 4:5 and 1.91:1 (single Reels are exempt). */
function aspectRatioError(m: MediaFile, inCarousel: boolean): string | null {
  if ((m.kind === "video" && !inCarousel) || !m.width || !m.height) return null;
  const ratio = m.width / m.height;
  if (ratio < 0.8 - 0.005 || ratio > 1.91 + 0.005) {
    const what = m.kind === "video" ? "carousel videos" : "photos";
    return `Instagram only accepts ${what} between 4:5 (portrait) and 1.91:1 (landscape); "${m.filename}" is ${m.width}×${m.height}. Crop it first.`;
  }
  return null;
}

/** Waits until every container is processed, checking them all in one request per round. */
async function waitForContainers(ctx: PublishContext, ids: string[], token: string, what: string): Promise<void> {
  await pollUntil(
    ctx.sleep,
    async () => {
      const res = await graph(graphUrl(ctx.config, ""), {
        query: { ids: ids.join(","), fields: "status_code,status", access_token: token },
      });
      for (const id of ids) {
        const c = res[id] ?? {};
        if (c.status_code === "ERROR" || c.status_code === "EXPIRED") {
          throw new Error(`Instagram couldn't process the ${what}: ${c.status ?? c.status_code}`);
        }
      }
      return ids.every((id) => ["FINISHED", "PUBLISHED"].includes(res[id]?.status_code)) ? true : null;
    },
    { intervalMs: 5000, maxIntervalMs: 60_000, timeoutMs: 20 * 60_000, what: `Instagram to process the ${what}` },
  );
}

async function containerStatus(ctx: PublishContext, id: string, token: string): Promise<string | null> {
  try {
    return (await graph(graphUrl(ctx.config, id), { query: { fields: "status_code", access_token: token } })).status_code ?? null;
  } catch {
    return null;
  }
}

/** Creates a video container and uploads the file straight to Meta (no public URL needed). */
async function createVideoContainer(
  ctx: PublishContext,
  token: string,
  video: MediaFile,
  fields: Record<string, string | undefined>,
): Promise<string> {
  const igId = ctx.account.externalId;
  const container = await graph<{ id: string; uri?: string }>(
    graphUrl(ctx.config, `${igId}/media`),
    { method: "POST", form: { ...fields, upload_type: "resumable", access_token: token } },
    { permissionHint: PERMISSION_HINT },
  );
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
  const res = await graph<{ id: string }>(
    graphUrl(ctx.config, `${ctx.account.externalId}/media`),
    { method: "POST", form: { ...fields, image_url: ctx.media.publicUrl(jpeg.file), access_token: token } },
    { permissionHint: PERMISSION_HINT },
  );
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
    const carousel = input.media.length > 1;
    for (const m of input.media) {
      const err = aspectRatioError(m, carousel);
      if (err) errors.push(err);
      if (m.kind !== "video") continue;
      if (!["video/mp4", "video/quicktime", "video/x-m4v"].includes(m.mime)) errors.push("Instagram only accepts MP4 or MOV videos.");
      if (!carousel && m.size > MAX_REEL_BYTES) errors.push("Instagram Reels must be 300 MB or smaller.");
      const max = carousel ? 60 : 15 * 60;
      if (m.duration !== null && (m.duration < 3 || m.duration > max)) {
        errors.push(
          carousel
            ? `Videos in an Instagram carousel must be 3–60 seconds long ("${m.filename}" is ${Math.round(m.duration)} s).`
            : `Instagram Reels must be between 3 seconds and 15 minutes long (this one is ${Math.round(m.duration)} s).`,
        );
      }
    }
    const hashtags = input.text.match(/(^|\s)#[^\s#]+/g)?.length ?? 0;
    if (hashtags > 30) errors.push(`Instagram allows at most 30 hashtags (you have ${hashtags}).`);
    const mentions = input.text.match(/(^|[^\w@])@[A-Za-z0-9._]+/g)?.length ?? 0;
    if (mentions > 20) errors.push(`Instagram allows at most 20 @mentions (you have ${mentions}).`);
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
      // Create (and upload) every item first, then wait for all of them together.
      const children: string[] = [];
      for (const [i, m] of media.entries()) {
        ctx.progress(`Preparing carousel item ${i + 1} of ${media.length}…`);
        children.push(
          m.kind === "video"
            ? await createVideoContainer(ctx, token, m, { media_type: "VIDEO", is_carousel_item: "true" })
            : await createImageContainer(ctx, token, m, { is_carousel_item: "true" }),
        );
      }
      ctx.progress("Waiting for Instagram to process the carousel items…");
      await waitForContainers(ctx, children, token, "carousel items");
      const res = await graph<{ id: string }>(
        graphUrl(ctx.config, `${igId}/media`),
        { method: "POST", form: { media_type: "CAROUSEL", children: children.join(","), caption: text, access_token: token } },
        { permissionHint: PERMISSION_HINT },
      );
      containerId = res.id;
    }

    ctx.progress(`Waiting for Instagram to process the ${what}…`);
    await waitForContainers(ctx, [containerId], token, what);

    ctx.progress("Publishing on Instagram…");
    const outcome = await publishContainerOnce({
      platformName: "Instagram",
      sleep: ctx.sleep,
      publish: () =>
        graph<{ id: string }>(
          graphUrl(ctx.config, `${igId}/media_publish`),
          { method: "POST", form: { creation_id: containerId, access_token: token } },
          { permissionHint: PERMISSION_HINT },
        ),
      status: () => containerStatus(ctx, containerId, token),
    });
    if ("publishedContainer" in outcome) {
      // It went live but we never got the media id: look up the newest post (best effort, for the link).
      try {
        const recent = await graph(graphUrl(ctx.config, `${igId}/media`), { query: { fields: "id,permalink,timestamp", limit: 1, access_token: token } });
        const latest = recent.data?.[0];
        if (latest && Date.now() - Date.parse(latest.timestamp) < 15 * 60_000) return { remoteId: latest.id, url: latest.permalink ?? null };
      } catch {
        // fall through
      }
      return { remoteId: containerId, url: null, note: "Published, but Instagram didn't confirm it in time, so there's no direct link." };
    }
    const published = outcome;

    let url: string | null = null;
    try {
      const res = await graph(graphUrl(ctx.config, published.id), { query: { fields: "permalink", access_token: token } });
      url = res.permalink ?? null;
    } catch {
      // already published; the link is a nice-to-have
    }
    return { remoteId: published.id, url };
  },

  async checkConnection(ctx) {
    const { accessToken: token } = (await ctx.credentials()) as InstagramCredentials;
    const ig = await graph(graphUrl(ctx.config, ctx.account.externalId), { query: { fields: "id,username", access_token: token } });
    return `Can post as @${ig.username}.`;
  },
};
