import { isPrivateBaseUrl, type Config } from "./config.js";
import type { PostSyncEmitter } from "./events.js";
import { UserError } from "./http.js";
import type { MediaFile, MediaStore } from "./media.js";
import { getPlatform } from "./platforms/index.js";
import type { Platform, PublishInput } from "./platforms/types.js";
import { newId } from "./storage/schema.js";
import type { AccountRow, PostCursor, PostRow, Storage, TargetRow } from "./storage/types.js";
import { measureText } from "./text.js";
import type { PlatformId, PostPage, PostRequest, PublicPost, PublicTarget, TargetIssue, TargetRequest } from "./types.js";

export type { PostRequest, TargetIssue, TargetRequest };

const MAX_SCHEDULE_AHEAD_MS = 5 * 366 * 86400_000;

/**
 * Reads a `nextBefore` cursor ("<createdAt>_<id>"). A bare number still works as "created before"; anything else
 * is ignored.
 */
export function parseCursor(raw: unknown): PostCursor | undefined {
  if (typeof raw === "number") return Number.isSafeInteger(raw) && raw >= 0 ? { createdAt: raw, id: "" } : undefined;
  if (typeof raw !== "string") return undefined;
  const m = /^(\d{1,16})(?:_(.{1,200}))?$/s.exec(raw.trim());
  if (!m) return undefined;
  const createdAt = Number(m[1]);
  return Number.isSafeInteger(createdAt) ? { createdAt, id: m[2] ?? "" } : undefined;
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
      `${platform.name} downloads ${what} from this server, but its public URL (${config.publicBaseUrl}) isn't reachable from the internet. Deploy the server or use a tunnel such as cloudflared or ngrok.`,
    );
  }
  if (platform.validate) errors.push(...platform.validate(input, config));
  return [...new Set(errors)];
}

/** Checks the shape of an untrusted request body (e.g. JSON from a browser). */
export function parsePostRequest(body: unknown): PostRequest {
  if (!body || typeof body !== "object") throw new UserError("Send the post as a JSON object.");
  const b = body as Record<string, unknown>;
  const text = b.text ?? "";
  if (typeof text !== "string") throw new UserError("`text` must be a string.");
  const strings = (v: unknown, name: string): string[] | undefined => {
    if (v === undefined || v === null) return undefined;
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new UserError(`\`${name}\` must be a list of strings.`);
    return v as string[];
  };
  const record = (v: unknown, name: string) => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "object" || Array.isArray(v)) throw new UserError(`\`${name}\` must be an object.`);
    return v as Record<string, any>;
  };
  let targets: TargetRequest[] | undefined;
  if (b.targets !== undefined && b.targets !== null) {
    if (!Array.isArray(b.targets)) throw new UserError("`targets` must be a list.");
    targets = b.targets.map((t: any) => {
      if (!t || typeof t.accountId !== "string") throw new UserError("Each target needs an `accountId`.");
      if (t.text !== undefined && t.text !== null && typeof t.text !== "string") throw new UserError("A target's `text` must be a string.");
      return { accountId: t.accountId, text: t.text ?? null, options: record(t.options, "targets[].options") };
    });
  }
  if (b.title !== undefined && b.title !== null && typeof b.title !== "string") throw new UserError("`title` must be a string.");
  const scheduledAt = b.scheduledAt;
  if (scheduledAt !== undefined && scheduledAt !== null && typeof scheduledAt !== "string" && typeof scheduledAt !== "number") {
    throw new UserError("`scheduledAt` must be an ISO date-time string or epoch milliseconds.");
  }
  return {
    text,
    title: (b.title as string | null | undefined) ?? null,
    mediaIds: strings(b.mediaIds, "mediaIds"),
    targets,
    platforms: strings(b.platforms, "platforms") as PlatformId[] | undefined,
    platformOptions: record(b.platformOptions, "platformOptions"),
    platformText: record(b.platformText, "platformText"),
    scheduledAt: scheduledAt as string | number | null | undefined,
  };
}

export class PostService {
  constructor(
    private readonly db: Storage,
    private readonly media: MediaStore,
    private readonly config: Config,
    private readonly events: PostSyncEmitter,
    private readonly enabled: Set<PlatformId>,
  ) {}

  /** Media files by id. With an owner, only that owner's uploads can be used. */
  async loadMedia(ownerId: string | null, ids: string[]): Promise<MediaFile[]> {
    const files: MediaFile[] = [];
    for (const id of ids) {
      const row = await this.db.getMedia(ownerId, id);
      if (!row) throw new UserError(`Media ${id} not found. Upload it again.`);
      files.push(this.media.toFile(row));
    }
    return files;
  }

  /** Expands the request into concrete (account, input) pairs. */
  private async resolveTargets(ownerId: string, req: PostRequest, media: MediaFile[]) {
    const accounts = await this.db.listAccounts(ownerId);
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const requested: TargetRequest[] = [...(req.targets ?? [])];
    for (const p of req.platforms ?? []) {
      if (!getPlatform(p) || !this.enabled.has(p)) throw new UserError(`Unknown platform "${p}".`);
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
        const account: AccountRow | undefined = byId.get(t.accountId);
        if (!account) throw new UserError(`Account ${t.accountId} isn't connected.`);
        const platform = getPlatform(account.platform)!;
        if (!this.enabled.has(platform.id)) throw new UserError(`Posting to ${platform.name} is turned off.`);
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

  async validate(ownerId: string, req: PostRequest): Promise<TargetIssue[]> {
    const media = await this.loadMedia(ownerId, req.mediaIds ?? []);
    return (await this.resolveTargets(ownerId, req, media)).map(({ account, platform, input }) => ({
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

  async create(ownerId: string, req: PostRequest): Promise<PublicPost> {
    if (typeof req.text !== "string") throw new UserError("`text` is required (it can be empty for media-only posts).");
    const issues = (await this.validate(ownerId, req)).filter((i) => i.errors.length);
    if (issues.length) {
      const detail = issues.map((i) => `${i.accountName} (${i.platform}): ${i.errors.join(" ")}`).join("\n");
      throw Object.assign(new UserError(`Some accounts can't take this post:\n${detail}`), { issues });
    }

    let scheduledAt: number | null = null;
    if (req.scheduledAt !== undefined && req.scheduledAt !== null && req.scheduledAt !== "") {
      // Whole milliseconds: the databases store integers.
      scheduledAt = Math.round(typeof req.scheduledAt === "number" ? req.scheduledAt : Date.parse(req.scheduledAt));
      if (!Number.isFinite(scheduledAt)) throw new UserError("scheduledAt must be an ISO date/time.");
      if (scheduledAt < Date.now() - 60_000) throw new UserError("The scheduled time is in the past.");
      if (scheduledAt > Date.now() + MAX_SCHEDULE_AHEAD_MS) throw new UserError("The scheduled time is more than 5 years ahead.");
    }

    const media = await this.loadMedia(ownerId, req.mediaIds ?? []);
    const resolved = await this.resolveTargets(ownerId, req, media);
    const now = Date.now();
    const post: PostRow = {
      id: newId(),
      owner_id: ownerId,
      text: req.text.trim(),
      title: req.title?.trim() || null,
      media_ids: JSON.stringify([...new Set(media.map((m) => m.id))]),
      scheduled_at: scheduledAt,
      created_at: now,
    };
    const runAt = scheduledAt ?? now;
    const targets: TargetRow[] = resolved.map(({ account, input, override }) => ({
      id: newId(),
      post_id: post.id,
      owner_id: ownerId,
      account_id: account.id,
      account_name: account.name,
      platform: account.platform,
      text_override: override,
      options: JSON.stringify(input.options),
      status: "queued",
      attempts: 0,
      run_at: runAt,
      lease_until: null,
      progress: scheduledAt ? null : "Waiting to start…",
      error: null,
      remote_id: null,
      remote_url: null,
      started_at: null,
      finished_at: null,
      created_at: now,
      updated_at: now,
    }));
    await this.db.insertPost(post, targets);
    const [created] = await this.serialize([post]);
    this.events.emit("post.created", { post: created });
    return created;
  }

  async get(ownerId: string, id: string): Promise<PublicPost | null> {
    const row = await this.db.getPost(ownerId, id);
    return row ? (await this.serialize([row]))[0] : null;
  }

  /** Newest first. `before` is the previous page's `nextBefore`; an invalid cursor is ignored (first page). */
  async list(ownerId: string, opts: { limit?: number; before?: string | null } = {}): Promise<PostPage> {
    const limit = Math.min(100, Math.max(1, Math.floor(opts.limit ?? 20) || 20));
    const rows = await this.db.listPosts(ownerId, limit, parseCursor(opts.before));
    const last = rows[rows.length - 1];
    return { posts: await this.serialize(rows), nextBefore: rows.length === limit ? `${last.created_at}_${last.id}` : null };
  }

  /**
   * Removes a post from the history (it is not deleted from the platforms). Queued jobs are cancelled with it.
   * Refuses while a job is running.
   */
  async remove(ownerId: string, id: string): Promise<"deleted" | "not_found" | "running"> {
    const row = await this.db.getPost(ownerId, id);
    if (!row) return "not_found";
    const result = await this.db.deletePostIfIdle(ownerId, row.id);
    if (result === "deleted") await this.media.removeIfUnused(JSON.parse(row.media_ids));
    return result;
  }

  /** The input a target publishes, rebuilt from the stored post. */
  async inputFor(target: TargetRow, post: PostRow): Promise<PublishInput> {
    return {
      text: target.text_override ?? post.text,
      title: post.title,
      media: await this.loadMedia(post.owner_id, JSON.parse(post.media_ids)),
      options: JSON.parse(target.options || "{}"),
    };
  }

  targetToPublic(t: TargetRow): PublicTarget {
    return {
      id: t.id,
      postId: t.post_id,
      ownerId: t.owner_id,
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
    };
  }

  async serialize(posts: PostRow[]): Promise<PublicPost[]> {
    const targets = await this.db.targetsForPosts(posts.map((p) => p.id));
    const out: PublicPost[] = [];
    for (const p of posts) {
      const media: PublicPost["media"] = [];
      for (const id of JSON.parse(p.media_ids) as string[]) {
        const row = await this.db.getMedia(p.owner_id, id);
        media.push(
          row
            ? { id, kind: row.kind, filename: row.filename, url: this.media.publicUrl(row.file), thumbnailUrl: this.media.thumbnailUrl(row) }
            : { id, kind: "missing", filename: "(deleted)", url: null, thumbnailUrl: null },
        );
      }
      out.push({
        id: p.id,
        ownerId: p.owner_id,
        text: p.text,
        title: p.title,
        scheduledAt: p.scheduled_at,
        createdAt: p.created_at,
        media,
        targets: targets.filter((t) => t.post_id === p.id).map((t) => this.targetToPublic(t)),
      });
    }
    return out;
  }
}
