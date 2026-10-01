import type { PlatformId } from "./platforms/types.js";

const URL_RE = /https?:\/\/[^\s<>"]+/gi;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** X counts every link as 23 characters and most non-Latin characters / emoji as 2. */
export function xLength(text: string): number {
  let n = 0;
  const withoutUrls = text.replace(URL_RE, () => {
    n += 23;
    return "";
  });
  for (const ch of withoutUrls) {
    const cp = ch.codePointAt(0)!;
    const light =
      cp <= 0x10ff || (cp >= 0x2000 && cp <= 0x200d) || (cp >= 0x2010 && cp <= 0x201f) || (cp >= 0x2032 && cp <= 0x2037);
    n += light ? 1 : 2;
  }
  return n;
}

export function graphemeLength(text: string): number {
  let n = 0;
  for (const _ of segmenter.segment(text)) n++;
  return n;
}

/** Text length the way each platform counts it (close enough for validation). */
export function measureText(platform: PlatformId, text: string): number {
  if (platform === "x") return xLength(text);
  if (platform === "bluesky") return graphemeLength(text);
  return [...text].length;
}
