import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import type { Config } from "./config.js";
import type { Secrets } from "./crypto.js";
import { newId, type DB, type MediaRow } from "./db.js";
import { UserError } from "./http.js";

const run = promisify(execFile);

const MIME_EXT: Record<string, { ext: string; kind: "image" | "video" }> = {
  "image/jpeg": { ext: ".jpg", kind: "image" },
  "image/png": { ext: ".png", kind: "image" },
  "image/webp": { ext: ".webp", kind: "image" },
  "image/gif": { ext: ".gif", kind: "image" },
  "video/mp4": { ext: ".mp4", kind: "video" },
  "video/quicktime": { ext: ".mov", kind: "video" },
  "video/webm": { ext: ".webm", kind: "video" },
  "video/x-m4v": { ext: ".m4v", kind: "video" },
};

const EXT_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".m4v": "video/x-m4v",
};

export const SUPPORTED_MIME_TYPES = Object.keys(MIME_EXT);

/** A media file attached to a post, as handed to platform publishers. */
export interface MediaFile {
  id: string;
  filename: string;
  /** Absolute path on disk. */
  path: string;
  /** Stored file name (relative to the media dir). */
  file: string;
  mime: string;
  kind: "image" | "video";
  size: number;
  width: number | null;
  height: number | null;
  /** Seconds (videos only). */
  duration: number | null;
}

let ffmpegAvailable: boolean | null = null;
export async function hasFfmpeg(): Promise<boolean> {
  if (ffmpegAvailable === null) {
    try {
      await run("ffprobe", ["-version"]);
      await run("ffmpeg", ["-version"]);
      ffmpegAvailable = true;
    } catch {
      ffmpegAvailable = false;
    }
  }
  return ffmpegAvailable;
}

export async function probe(file: string): Promise<{ width: number | null; height: number | null; duration: number | null }> {
  if (!(await hasFfmpeg())) return { width: null, height: null, duration: null };
  try {
    const { stdout } = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file], {
      maxBuffer: 10 * 1024 * 1024,
    });
    const info = JSON.parse(stdout);
    const stream = (info.streams ?? []).find((s: any) => s.codec_type === "video");
    let width = stream?.width ?? null;
    let height = stream?.height ?? null;
    // Phone videos are often stored landscape with a rotation flag.
    const rotation = Math.abs(
      Number(stream?.tags?.rotate ?? stream?.side_data_list?.find((d: any) => d.rotation !== undefined)?.rotation ?? 0),
    );
    if (rotation === 90 || rotation === 270) [width, height] = [height, width];
    const duration = Number.parseFloat(info.format?.duration ?? stream?.duration ?? "");
    return { width, height, duration: Number.isFinite(duration) ? duration : null };
  } catch {
    return { width: null, height: null, duration: null };
  }
}

export function mimeFromFilename(filename: string): string | null {
  return EXT_MIME[path.extname(filename).toLowerCase()] ?? null;
}

export class MediaStore {
  constructor(
    private readonly db: DB,
    private readonly config: Config,
    private readonly secrets: Secrets,
  ) {}

  /** Saves an uploaded stream to disk and records it. */
  async save(stream: Readable, filename: string, mimeType: string): Promise<MediaRow> {
    let mime = mimeType.toLowerCase();
    if (!MIME_EXT[mime]) mime = mimeFromFilename(filename) ?? mime;
    const type = MIME_EXT[mime];
    if (!type) {
      stream.resume();
      throw new UserError(`Unsupported file type "${mimeType}". Use JPEG/PNG/WebP/GIF images or MP4/MOV/WebM videos.`);
    }
    const id = newId();
    const file = id + type.ext;
    const dest = path.join(this.config.mediaDir, file);
    try {
      await pipeline(stream, fs.createWriteStream(dest));
      if ((stream as any).truncated) {
        throw new UserError(`File is larger than the ${Math.round(this.config.maxUploadBytes / 1024 / 1024)} MB upload limit.`);
      }
    } catch (err) {
      await fsp.rm(dest, { force: true });
      throw err;
    }
    const { size } = await fsp.stat(dest);
    const meta = await probe(dest);
    if (type.kind === "video") await this.makePoster(dest, id, meta.duration);
    const row: MediaRow = {
      id,
      filename: path.basename(filename).slice(0, 200) || file,
      file,
      mime,
      kind: type.kind,
      size,
      width: meta.width,
      height: meta.height,
      duration: type.kind === "video" ? meta.duration : null,
      created_at: Date.now(),
    };
    this.db.insertMedia(row);
    return row;
  }

  /** A small JPEG frame of a video, so the dashboard can show thumbnails in any browser. */
  private async makePoster(video: string, id: string, duration: number | null): Promise<void> {
    if (!(await hasFfmpeg())) return;
    const at = duration && duration > 2 ? "1" : "0";
    const out = path.join(this.config.mediaDir, `${id}.poster.jpg`);
    try {
      await run("ffmpeg", ["-y", "-v", "error", "-ss", at, "-i", video, "-frames:v", "1", "-vf", "scale='min(640,iw)':-2", "-q:v", "4", out]);
    } catch {
      // thumbnails are cosmetic
    }
  }

  /** Thumbnail to show in the dashboard: the image itself, or a video's poster frame (null if none). */
  thumbPath(row: MediaRow): string | null {
    if (row.kind === "image") return this.previewPath(row.file);
    const poster = `${row.id}.poster.jpg`;
    return fs.existsSync(path.join(this.config.mediaDir, poster)) ? this.previewPath(poster) : null;
  }

  toFile(row: MediaRow): MediaFile {
    return {
      id: row.id,
      filename: row.filename,
      file: row.file,
      path: path.join(this.config.mediaDir, row.file),
      mime: row.mime,
      kind: row.kind,
      size: row.size,
      width: row.width,
      height: row.height,
      duration: row.duration,
    };
  }

  async remove(row: MediaRow): Promise<void> {
    const prefix = row.id;
    const entries = await fsp.readdir(this.config.mediaDir);
    await Promise.all(
      entries.filter((e) => e.startsWith(prefix)).map((e) => fsp.rm(path.join(this.config.mediaDir, e), { force: true })),
    );
    this.db.deleteMedia(row.id);
  }

  /** Deletes the given media files unless another post still uses them. */
  async removeIfUnused(ids: string[]): Promise<void> {
    for (const id of ids) {
      const row = this.db.getMedia(id);
      if (row && !this.db.isMediaReferenced(id)) await this.remove(row);
    }
  }

  /** Deletes uploads that never made it into a post. */
  async cleanupOrphans(maxAgeMs = 24 * 3600_000): Promise<number> {
    const rows = this.db.orphanMedia(Date.now() - maxAgeMs);
    for (const row of rows) await this.remove(row);
    return rows.length;
  }

  /** Unguessable public URL for a stored file, so Instagram/Threads servers can download it. */
  publicUrl(file: string): string {
    const sig = this.secrets.sign("media:" + file).slice(0, 32);
    return `${this.config.publicBaseUrl}/media/${sig}/${encodeURIComponent(file)}`;
  }

  /** Same signed URL, relative to this server (for previews in the dashboard). */
  previewPath(file: string): string {
    return new URL(this.publicUrl(file)).pathname;
  }

  verifyPublicUrl(sig: string, file: string): boolean {
    if (!/^[A-Za-z0-9-]+(\.[a-z0-9-]+)*\.[a-z0-9]+$/.test(file)) return false;
    return this.secrets.sign("media:" + file).slice(0, 32) === sig;
  }

  /**
   * Returns a JPEG version of an image (Instagram only accepts JPEG; Bluesky caps images at ~1 MB).
   * Converted files are cached next to the original.
   */
  async jpegVariant(media: MediaFile, opts: { maxBytes?: number; maxDimension?: number } = {}): Promise<MediaFile> {
    if (media.kind !== "image") throw new Error("jpegVariant() only works on images");
    const fits = (size: number) => !opts.maxBytes || size <= opts.maxBytes;
    const smallEnough =
      !opts.maxDimension || ((media.width ?? 0) <= opts.maxDimension && (media.height ?? 0) <= opts.maxDimension);
    if (media.mime === "image/jpeg" && fits(media.size) && smallEnough) return media;

    if (!(await hasFfmpeg())) {
      throw new UserError(
        `This platform needs a JPEG${opts.maxBytes ? ` under ${Math.floor(opts.maxBytes / 1000)} KB` : ""}; install ffmpeg on the server so images can be converted automatically, or upload a JPEG.`,
      );
    }

    const maxDim = opts.maxDimension ?? 4096;
    const attempts: Array<{ q: number; dim: number }> = [
      { q: 2, dim: maxDim },
      { q: 5, dim: maxDim },
      { q: 5, dim: Math.min(maxDim, 2000) },
      { q: 8, dim: Math.min(maxDim, 1600) },
      { q: 12, dim: Math.min(maxDim, 1200) },
      { q: 18, dim: Math.min(maxDim, 1000) },
    ];
    for (const { q, dim } of attempts) {
      const file = `${media.id}.q${q}-${dim}.jpg`;
      const out = path.join(this.config.mediaDir, file);
      if (!fs.existsSync(out)) {
        // Flatten transparency onto white (JPEG has no alpha), keep aspect ratio, never upscale.
        const filter = `scale='min(${dim},iw)':'min(${dim},ih)':force_original_aspect_ratio=decrease,format=rgba,split[a][b];[a]drawbox=c=white:t=fill[bg];[bg][b]overlay,format=yuvj420p`;
        await run("ffmpeg", ["-y", "-v", "error", "-i", media.path, "-frames:v", "1", "-filter_complex", filter, "-q:v", String(q), out]);
      }
      const { size } = await fsp.stat(out);
      if (fits(size)) {
        const meta = await probe(out);
        return { ...media, file, path: out, mime: "image/jpeg", size, width: meta.width, height: meta.height };
      }
    }
    throw new UserError(`Couldn't shrink "${media.filename}" below ${Math.floor((opts.maxBytes ?? 0) / 1000)} KB.`);
  }
}

/** Reads bytes [start, end] (inclusive) of a file. */
export async function readRange(file: string, start: number, end: number): Promise<Buffer<ArrayBuffer>> {
  const length = end - start + 1;
  const handle = await fsp.open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
      if (bytesRead === 0) throw new Error(`Unexpected end of file reading ${file}`);
      offset += bytesRead;
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

/** A Blob backed by the file on disk, so uploads stream instead of loading whole videos in memory. */
export async function fileBlob(media: MediaFile): Promise<Blob> {
  return fs.openAsBlob(media.path, { type: media.mime });
}
