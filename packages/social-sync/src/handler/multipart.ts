import busboy from "busboy";
import { Readable } from "node:stream";
import { UserError } from "../http.js";
import type { MediaUpload } from "../sync.js";

/**
 * Streams the files of a multipart/form-data request to `onFile` one after another, so large videos never sit in
 * memory. Returns what `onFile` returned for each file.
 */
export async function parseMultipart<T>(
  request: Request,
  opts: { maxFileBytes: number; maxFiles: number; onFile: (file: MediaUpload) => Promise<T> },
): Promise<T[]> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("multipart/form-data")) throw new UserError("Upload files as multipart/form-data.");
  if (!request.body) return [];

  let bb: busboy.Busboy;
  try {
    bb = busboy({
      headers: { "content-type": type },
      limits: { fileSize: opts.maxFileBytes, files: opts.maxFiles, fields: 50, fieldSize: 64 * 1024 },
    });
  } catch {
    throw new UserError("Malformed multipart request.");
  }

  return new Promise<T[]>((resolve, reject) => {
    const results: T[] = [];
    let chain: Promise<void> = Promise.resolve();
    let failed: unknown = null;
    const source = Readable.fromWeb(request.body as any);
    const files: Readable[] = [];

    const abort = (err: unknown) => {
      if (failed) return;
      failed = err;
      source.unpipe(bb);
      source.destroy();
      // Busboy never ends a file that was cut off: close it so `onFile` fails and removes what it wrote, then answer.
      for (const file of files) if (!file.readableEnded) file.destroy();
      chain.then(
        () => reject(err),
        () => reject(err),
      );
    };

    bb.on("file", (_field, stream, info) => {
      if (failed) {
        stream.resume();
        return;
      }
      files.push(stream);
      // Files are handled in order; each one is fully written before the next starts.
      chain = chain.then(async () => {
        if (failed) {
          stream.resume();
          return;
        }
        results.push(await opts.onFile({ stream, filename: info.filename || "upload", mimeType: info.mimeType }));
      });
      chain.catch(abort);
      stream.on("limit", () => abort(new UserError(`File is larger than the ${Math.round(opts.maxFileBytes / 1024 / 1024)} MB upload limit.`)));
    });
    bb.on("filesLimit", () => abort(new UserError(`Too many files (max ${opts.maxFiles}).`)));
    bb.on("error", (err) => abort(err instanceof Error ? new UserError(`Upload failed: ${err.message}`) : err));
    bb.on("close", () => {
      chain.then(
        () => {
          if (!failed) resolve(results);
        },
        abort,
      );
    });
    source.on("error", (err) => abort(err));
    source.pipe(bb);
  });
}
