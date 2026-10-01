import twitterText from "twitter-text";
import type { PlatformId } from "./platforms/types.js";

export const URL_RE = /https?:\/\/[^\s<>"]+/gi;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const utf8 = new TextEncoder();
// One whole emoji (incl. flags, skin tones, keycaps, ZWJ families). Built at runtime: the `v` flag needs ES2024 typings.
const EMOJI = new RegExp("^\\p{RGI_Emoji}$", "v");

/** X's own counter (twitter-text): links count 23, emoji 2, CJK 2, text NFC-normalized. */
export function xLength(text: string): number {
  return twitterText.parseTweet(text).weightedLength;
}

export function graphemeLength(text: string): number {
  let n = 0;
  for (const _ of segmenter.segment(text)) n++;
  return n;
}

/** Threads counts each emoji as its UTF-8 byte length (usually 4 or more) toward the 500 limit. */
export function threadsLength(text: string): number {
  let n = 0;
  for (const { segment } of segmenter.segment(text)) n += EMOJI.test(segment) ? utf8.encode(segment).length : [...segment].length;
  return n;
}

/** Text length the way each platform counts it (close enough for validation). */
export function measureText(platform: PlatformId, text: string): number {
  switch (platform) {
    case "x":
      return xLength(text);
    case "bluesky":
      return graphemeLength(text);
    case "threads":
      return threadsLength(text);
    case "tiktok":
      return text.length; // TikTok counts UTF-16 units, so emoji count 2
    default:
      return [...text].length;
  }
}
