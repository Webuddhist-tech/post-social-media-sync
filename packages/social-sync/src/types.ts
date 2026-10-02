/**
 * Public types shared by the server package and the browser client. No Node.js imports here.
 */

export type PlatformId = "facebook" | "instagram" | "threads" | "tiktok" | "linkedin" | "youtube" | "x" | "bluesky";
export type ConnectorId = "meta" | "threads" | "tiktok" | "linkedin" | "google" | "x" | "bluesky";
export type TargetStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface Capabilities {
  /** Whether a post with no media is allowed. */
  textOnly: boolean;
  /** Max caption length (as the platform counts characters). */
  maxTextLength: number;
  /** Max number of images in one post (0 = images not supported). */
  maxImages: number;
  /** Whether a (single) video is supported. */
  video: boolean;
  /** Whether images and videos can be mixed in one post. */
  mixedMedia: boolean;
  /** Max number of media items when mixing is allowed. */
  maxMediaItems?: number;
  /** Which media the platform downloads from our public media URL (so it must be reachable from the internet). */
  needsPublicMediaUrl: false | "images" | "all";
  /** Whether the post title is used. */
  usesTitle: boolean;
}

export interface OptionField {
  key: string;
  label: string;
  type: "select" | "checkbox" | "text";
  choices?: Array<{ value: string; label: string }>;
  default?: string | boolean;
  help?: string;
  /** false = a UI must not remember this choice for the next post (e.g. TikTok privacy, per TikTok's rules). */
  remember?: boolean;
}

export interface CredentialField {
  key: string;
  label: string;
  type: "text" | "password" | "url";
  placeholder?: string;
  help?: string;
  required?: boolean;
}

export interface PlatformDescription {
  id: PlatformId;
  name: string;
  connector: ConnectorId;
  capabilities: Capabilities;
  options: OptionField[];
}

export interface ConnectorDescription {
  id: ConnectorId;
  name: string;
  platforms: PlatformId[];
  /** "oauth": redirect the user to the platform; "credentials": collect `credentialFields` in your UI. */
  kind: "oauth" | "credentials";
  /** Whether the app keys for this platform are set. */
  configured: boolean;
  /** Redirect URI to register in the platform's developer console (OAuth connectors). */
  redirectUri: string | null;
  developerPortal: string | null;
  credentialFields: CredentialField[] | null;
}

export interface Description {
  /** Public base URL of the handler (OAuth callbacks and media URLs live under it). */
  publicUrl: string;
  /** False when publicUrl is a private address: Instagram photos and Threads media can't be fetched then. */
  publicMediaReachable: boolean;
  ffmpeg: boolean;
  maxUploadMb: number;
  supportedMimeTypes: string[];
  platforms: PlatformDescription[];
  connectors: ConnectorDescription[];
}

export interface PublicAccount {
  id: string;
  ownerId: string;
  platform: PlatformId;
  connector: ConnectorId;
  name: string;
  username: string | null;
  avatarUrl: string | null;
  status: "active" | "needs_reauth";
  statusMessage: string | null;
  expiresAt: number | null;
  createdAt: number;
}

export interface PublicMedia {
  id: string;
  ownerId: string;
  filename: string;
  kind: "image" | "video";
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  /** Signed URL of the file (public on purpose: some platforms download from it). */
  url: string;
  /** Thumbnail URL (the image itself, or a video's poster frame when ffmpeg is available). */
  thumbnailUrl: string | null;
  createdAt: number;
}

export interface PublicTarget {
  id: string;
  postId: string;
  ownerId: string;
  accountId: string;
  accountName: string;
  platform: PlatformId;
  status: TargetStatus;
  attempts: number;
  /** When it runs (or ran): the scheduled time, or the next retry. */
  runAt: number;
  /** Live progress while running; extra info (e.g. "processing on YouTube") after success. */
  progress: string | null;
  error: string | null;
  remoteId: string | null;
  /** Link to the published post. */
  remoteUrl: string | null;
  textOverride: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface PublicPost {
  id: string;
  ownerId: string;
  text: string;
  title: string | null;
  scheduledAt: number | null;
  createdAt: number;
  media: Array<{ id: string; kind: "image" | "video" | "missing"; filename: string; url: string | null; thumbnailUrl: string | null }>;
  targets: PublicTarget[];
}

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
  /** Explicit accounts to post to. */
  targets?: TargetRequest[];
  /** Shortcut: every active connected account on these platforms. */
  platforms?: PlatformId[];
  /** Options per platform, applied to every account of that platform (see `PlatformDescription.options`). */
  platformOptions?: Partial<Record<PlatformId, Record<string, unknown>>>;
  /** Caption override per platform. */
  platformText?: Partial<Record<PlatformId, string | null>>;
  /** ISO date-time or epoch ms. Omit to publish now. */
  scheduledAt?: string | number | null;
}

export interface TargetIssue {
  accountId: string;
  accountName: string;
  platform: PlatformId;
  errors: string[];
  /** Caption length as this platform counts it. */
  length: number;
}

/** Result of checking that a saved login still works. */
export interface CheckResult {
  ok: boolean;
  /** What the account can do, when ok. */
  detail?: string;
  error?: string;
  /** The login is no longer valid: send the user through connect again. */
  needsReconnect?: boolean;
}

export interface PostPage {
  posts: PublicPost[];
  /** Opaque cursor: pass it as `before` to get the next page; null when there are no more posts. */
  nextBefore: string | null;
}

/** Events emitted by the engine (`sync.on(...)`), and sent to webhooks by the standalone server. */
export interface PostSyncEvents {
  "post.created": { post: PublicPost };
  "target.started": { target: PublicTarget };
  "target.progress": { target: PublicTarget; message: string };
  "target.succeeded": { target: PublicTarget };
  "target.failed": { target: PublicTarget; error: string; willRetry: boolean; retryAt: number | null };
  "target.cancelled": { target: PublicTarget };
  "account.connected": { accounts: PublicAccount[] };
  "account.disconnected": { account: PublicAccount };
  "account.needsReconnect": { account: PublicAccount; message: string };
}

export type PostSyncEventName = keyof PostSyncEvents;
