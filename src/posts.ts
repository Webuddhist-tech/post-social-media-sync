import { isPrivateBaseUrl, type Config } from "./config.js";
import { newId, type DB, type PostRow, type TargetRow } from "./db.js";
import { UserError } from "./http.js";
import type { MediaFile, MediaStore } from "./media.js";
import { getPlatform } from "./platforms/index.js";
import type { Platform, PublishInput } from "./platforms/types.js";
import { measureText } from "./text.js";

export interface TargetRequest {
  accountId: string;
  /** Per-account caption override. */
  text?: string | null;
  options?: Record<string, unknown>;
}

export interface PostRequest {
  text: string;
  title?: string | null;
  mediaIds?: string[];
  targets?: TargetRequest[];
  /** Shortcut for API users: post to every connected account on these platforms. */
  platforms?: string[];
  /** Per-platform options/captions applied to every account of that platform (UI sends these). */
  platformOptions?: Record<string, Record<string, unknown>>;
  platformText?: Record<string, string | null>;
  scheduledAt?: string | number | null;
}

export interface TargetIssue {
  accountId: string;
  accountName: string;
  platform: string;
  errors: string[];
  /** Caption length as the platform counts it (the dashboard shows it for X, whose rules are complex). */
  length: number;
}

/** Fills in option defaults so the publisher always sees a complete set. */
export function withDefaults(platform: Platform, options: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of platform.options) {
    const v = options[f.key];
    if (v === undefined || v === null || v === "") out[f.key] = f.default ?? null;
    else if (f.type === "checkbox") out[f.key] = v === true || v === "true" || v === "on" || v === 1;
    else if (f.type === "select" && f.choices && !f.choices.some((c) => c.value === String(v))) out[f.key] = f.default ?? null;
    else out[f.key] = String(v);
  }
  return out;
}

/** Generic checks every platform shares, driven by its declared capabilities. */
export function validateForPlatform(platform: Platform, input: PublishInput, config: Config): string[] {
  const caps = platform.capabilities;
  const errors: string[] = [];
  const images = input.media.filter((m) => m.kind === "image");
  const videos = input.media.filter((m) => m.kind === "video");

  if (!input.text.trim() && input.media.length === 0) errors.push("Write something or attach media.");
  if (input.media.length === 0 && !caps.textOnly) {
    errors.push(`${platform.name} needs ${caps.maxImages === 0 ? "a video" : "a photo or video"}.`);
  }

  const length = measureText(platform.id, input.text);
  const premium = platform.id === "x" && input.options.premium === true;
  const max = premium ? 25_000 : caps.maxTextLength;
  if (length > max) errors.push(`${platform.name} allows ${max.toLocaleString("en-US")} characters; this caption has ${length.toLocaleString("en-US")}.`);

  if (images.length && caps.maxImages === 0) errors.push(`${platform.name} doesn't support photo posts here, only video.`);
  else if (images.length > caps.maxImages && !caps.mixedMedia) errors.push(`${platform.name} allows at most ${caps.maxImages} photos.`);
  if (videos.length && !caps.video) errors.push(`${platform.name} doesn't support videos.`);
  if (images.length && videos.length && !caps.mixedMedia) errors.push(`${platform.name} can't mix photos and videos in one post.`);
  if (videos.length > 1 && !caps.mixedMedia) errors.push(`${platform.name} allows one video per post.`);
  if (caps.mixedMedia && caps.maxMediaItems && input.media.length > caps.maxMediaItems) {
    errors.push(`${platform.name} allows at most ${caps.maxMediaItems} items in one post.`);
  }
  const downloaded = caps.needsPublicMediaUrl === "all" ? input.media : caps.needsPublicMediaUrl === "images" ? images : [];
  if (downloaded.length && isPrivateBaseUrl(config.publicBaseUrl)) {
    const what = caps.needsPublicMediaUrl === "images" ? "photos" : "photos and videos";
    errors.push(
      `${platform.name} downloads ${what} from this server, but PUBLIC_BASE_URL (${config.publicBaseUrl}) isn't reachable from the internet. Deploy the server or use a tunnel (see README).`,
    );
  }
  if (platform.validate) errors.push(...platform.validate(input, config));
  return [...new Set(errors)];
}

export class PostService {
  constructor(
    private readonly db: DB,
    private readonly media: MediaStore,
    private readonly config: Config,
  ) {}

  loadMedia(ids: string[]): MediaFile[] {
    return ids.map((id) => {
      const row = this.db.getMedia(id);
      if (!row) throw new UserError(`Media ${id} not found. Upload it again.`);
      return this.media.toFile(row);
    });
  }

  /** Expands the request into concrete (account, input) pairs. */
  private resolveTargets(req: PostRequest, media: MediaFile[]) {
    const accounts = this.db.listAccounts();
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const requested: TargetRequest[] = [...(req.targets ?? [])];
    for (const p of req.platforms ?? []) {
      if (!getPlatform(p)) throw new UserError(`Unknown platform "${p}".`);
      for (const a of accounts) {
        if (a.platform === p && a.status === "active" && !requested.some((t) => t.accountId === a.id)) {
          requested.push({ accountId: a.id });
        }
      }
    }
    if (requested.length === 0) throw new UserError("Choose at least one account to post to.");

    const seen = new Set<string>();
    return requested
      .filter((t) => !seen.has(t.accountId) && seen.add(t.accountId))
      .map((t) => {
        const account = byId.get(t.accountId);
        if (!account) throw new UserError(`Account ${t.accountId} isn't connected.`);
        const platform = getPlatform(account.platform)!;
        const override = t.text ?? req.platformText?.[account.platform] ?? null;
        const input: PublishInput = {
          text: (override?.trim() ? override : req.text).trim(),
          title: req.title?.trim() || null,
          media,
          options: withDefaults(platform, { ...req.platformOptions?.[account.platform], ...t.options }),
        };
        return { account, platform, input, override: override?.trim() ? override.trim() : null };
      });
  }

  validate(req: PostRequest): TargetIssue[] {
    const media = this.loadMedia(req.mediaIds ?? []);
    return this.resolveTargets(req, media).map(({ account, platform, input }) => ({
      accountId: account.id,
      accountName: account.name,
      platform: account.platform,
      length: measureText(platform.id, input.text),
      errors: [
        ...(account.status === "needs_reauth" ? [`Reconnect this account first: ${account.status_message ?? "login expired"}`] : []),
        ...validateForPlatform(platform, input, this.config),
      ],
    }));
  }

  create(req: PostRequest): { post: PostRow; targets: TargetRow[] } {
    if (typeof req.text !== "string") throw new UserError("`text` is required (it can be empty for media-only posts).");
    const issues = this.validate(req).filter((i) => i.errors.length);
    if (issues.length) {
      const detail = issues.map((i) => `${i.accountName} (${i.platform}): ${i.errors.join(" ")}`).join("\n");
      throw Object.assign(new UserError(`Some accounts can't take this post:\n${detail}`), { issues });
    }

    let scheduledAt: number | null = null;
    if (req.scheduledAt !== undefined && req.scheduledAt !== null && req.scheduledAt !== "") {
      scheduledAt = typeof req.scheduledAt === "number" ? req.scheduledAt : Date.parse(req.scheduledAt);
      if (!Number.isFinite(scheduledAt)) throw new UserError("scheduledAt must be an ISO date/time.");
      if (scheduledAt < Date.now() - 60_000) throw new UserError("The scheduled time is in the past.");
    }

    const media = this.loadMedia(req.mediaIds ?? []);
    const resolved = this.resolveTargets(req, media);
    const post: PostRow = {
      id: newId(),
      text: req.text.trim(),
      title: req.title?.trim() || null,
      media_ids: JSON.stringify(media.map((m) => m.id)),
      scheduled_at: scheduledAt,
      created_at: Date.now(),
    };
    const runAt = scheduledAt ?? Date.now();
    const targets = resolved.map(({ account, input, override }) => ({
      id: newId(),
      post_id: post.id,
      account_id: account.id,
      account_name: account.name,
      platform: account.platform,
      text_override: override,
      options: JSON.stringify(input.options),
      status: "queued" as const,
      attempts: 0,
      run_at: runAt,
      progress: scheduledAt ? null : "Waiting to start…",
      error: null,
      remote_id: null,
      remote_url: null,
      started_at: null,
      finished_at: null,
    }));
    this.db.insertPost(post, targets);
    return { post, targets: this.db.targetsForPosts([post.id]) };
  }

  /** The input a target publishes, rebuilt from the stored post. */
  inputFor(target: TargetRow, post: PostRow): PublishInput {
    return {
      text: target.text_override ?? post.text,
      title: post.title,
      media: this.loadMedia(JSON.parse(post.media_ids)),
      options: JSON.parse(target.options || "{}"),
    };
  }

  serialize(posts: PostRow[]) {
    const targets = this.db.targetsForPosts(posts.map((p) => p.id));
    return posts.map((p) => {
      const mediaIds: string[] = JSON.parse(p.media_ids);
      return {
        id: p.id,
        text: p.text,
        title: p.title,
        scheduledAt: p.scheduled_at,
        createdAt: p.created_at,
        media: mediaIds.map((id) => {
          const row = this.db.getMedia(id);
          return row
            ? { id, kind: row.kind, filename: row.filename, previewUrl: this.media.previewPath(row.file), thumbUrl: this.media.thumbPath(row) }
            : { id, kind: "missing", filename: "(deleted)", previewUrl: null, thumbUrl: null };
        }),
        targets: targets
          .filter((t) => t.post_id === p.id)
          .map((t) => ({
            id: t.id,
            accountId: t.account_id,
            accountName: t.account_name,
            platform: t.platform,
            status: t.status,
            attempts: t.attempts,
            runAt: t.run_at,
            progress: t.progress,
            error: t.error,
            remoteId: t.remote_id,
            remoteUrl: t.remote_url,
            textOverride: t.text_override,
            startedAt: t.started_at,
            finishedAt: t.finished_at,
          })),
      };
    });
  }
}

