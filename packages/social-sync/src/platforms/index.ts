import { bluesky, blueskyConnector } from "./bluesky.js";
import { facebook } from "./facebook.js";
import { instagram } from "./instagram.js";
import { linkedin, linkedinConnector } from "./linkedin.js";
import { metaConnector } from "./meta.js";
import { threads, threadsConnector } from "./threads.js";
import { tiktokConnector, tiktokPlatform } from "./tiktok.js";
import type { Connector, ConnectorId, Platform, PlatformId } from "./types.js";
import { x, xConnector } from "./x.js";
import { googleConnector, youtube } from "./youtube.js";

export const PLATFORMS: Record<PlatformId, Platform> = {
  instagram,
  facebook,
  tiktok: tiktokPlatform,
  youtube,
  linkedin,
  threads,
  x,
  bluesky,
};

export const CONNECTORS: Record<ConnectorId, Connector> = {
  meta: metaConnector,
  tiktok: tiktokConnector,
  google: googleConnector,
  linkedin: linkedinConnector,
  threads: threadsConnector,
  x: xConnector,
  bluesky: blueskyConnector,
};

export function getPlatform(id: string): Platform | undefined {
  return Object.hasOwn(PLATFORMS, id) ? PLATFORMS[id as PlatformId] : undefined;
}

export function getConnector(id: string): Connector | undefined {
  return Object.hasOwn(CONNECTORS, id) ? CONNECTORS[id as ConnectorId] : undefined;
}
