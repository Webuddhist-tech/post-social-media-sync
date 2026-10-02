import type { ConnectorId, PlatformId, TargetStatus } from "../types.js";

/**
 * Where the engine keeps its data. Two implementations ship with the package (SQLite and PostgreSQL); implement
 * this interface to use another database. Every row belongs to an `owner_id` (your user/workspace id).
 * Methods that take `ownerId: string | null` treat null as "any owner" (internal use by the worker only).
 */
export interface Storage {
  /** Creates/updates the tables. Called once by the engine before use. */
  migrate(): Promise<void>;
  close(): Promise<void>;

  // accounts
  listAccounts(ownerId: string): Promise<AccountRow[]>;
  getAccount(ownerId: string | null, id: string): Promise<AccountRow | undefined>;
  /** Insert or update by (owner_id, platform, external_id). Returns the account id. */
  upsertAccount(a: NewAccount): Promise<string>;
  updateAccountCredentials(id: string, credentials: string, expiresAt: number | null): Promise<void>;
  setAccountStatus(id: string, status: AccountRow["status"], message: string | null): Promise<void>;
  deleteAccount(ownerId: string, id: string): Promise<boolean>;
  /** Accounts that share one login (same owner, connector and grant), e.g. a LinkedIn profile and its Pages. */
  accountsByGrant(ownerId: string, connector: string, grantId: string): Promise<AccountRow[]>;
  /** Active accounts whose token expires before `before` (all owners), for background token refresh. */
  accountsExpiringBefore(before: number): Promise<AccountRow[]>;

  // OAuth state (single use, short lived)
  saveOAuthState(row: OAuthStateRow): Promise<void>;
  takeOAuthState(state: string, notOlderThan: number): Promise<OAuthStateRow | undefined>;

  // media
  insertMedia(row: MediaRow): Promise<void>;
  getMedia(ownerId: string | null, id: string): Promise<MediaRow | undefined>;
  deleteMedia(id: string): Promise<void>;
  isMediaReferenced(id: string): Promise<boolean>;
  /** Media no post references, created before `olderThan`. */
  orphanMedia(olderThan: number): Promise<MediaRow[]>;

  // posts and their per-account targets
  insertPost(post: PostRow, targets: TargetRow[]): Promise<void>;
  getPost(ownerId: string | null, id: string): Promise<PostRow | undefined>;
  listPosts(ownerId: string, limit: number, before?: number): Promise<PostRow[]>;
  deletePost(ownerId: string, id: string): Promise<boolean>;
  targetsForPosts(postIds: string[]): Promise<TargetRow[]>;
  getTarget(ownerId: string | null, id: string): Promise<TargetRow | undefined>;
  hasActiveTargetsForAccount(accountId: string): Promise<boolean>;

  // queue
  /**
   * Atomically claims up to `limit` due targets: status queued and run_at <= now, at most one per account, and none
   * for an account that already has a running target (across all processes). Marks them running, increments
   * attempts and sets lease_until.
   */
  claimDueTargets(limit: number, now: number, leaseUntil: number): Promise<TargetRow[]>;
  renewLeases(ids: string[], leaseUntil: number): Promise<void>;
  setTargetProgress(id: string, progress: string): Promise<void>;
  completeTarget(id: string, remoteId: string, remoteUrl: string | null, note: string | null): Promise<void>;
  /** Back to queued for a retry at `retryAt`, or failed for good when retryAt is null. */
  failTarget(id: string, error: string, retryAt: number | null): Promise<void>;
  retryTarget(ownerId: string, id: string): Promise<boolean>;
  cancelTarget(ownerId: string, id: string): Promise<boolean>;
  /** Running targets whose lease expired (their process died). Marks them failed and returns them. */
  failExpiredLeases(now: number, message: string): Promise<TargetRow[]>;
}

export interface AccountRow {
  id: string;
  owner_id: string;
  platform: PlatformId;
  connector: ConnectorId;
  external_id: string;
  name: string;
  username: string | null;
  avatar_url: string | null;
  /** Encrypted JSON. */
  credentials: string;
  /** Non-secret JSON. */
  meta: string;
  grant_id: string | null;
  expires_at: number | null;
  status: "active" | "needs_reauth";
  status_message: string | null;
  created_at: number;
  updated_at: number;
}

export type NewAccount = Omit<AccountRow, "id" | "created_at" | "updated_at" | "status" | "status_message">;

export interface OAuthStateRow {
  state: string;
  owner_id: string;
  connector: string;
  code_verifier: string | null;
  return_to: string | null;
  created_at: number;
}

export interface MediaRow {
  id: string;
  owner_id: string;
  filename: string;
  /** Stored file name inside the media directory. */
  file: string;
  mime: string;
  kind: "image" | "video";
  size: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  created_at: number;
}

export interface PostRow {
  id: string;
  owner_id: string;
  text: string;
  title: string | null;
  /** JSON array of media ids, in order. */
  media_ids: string;
  scheduled_at: number | null;
  created_at: number;
}

export interface TargetRow {
  id: string;
  post_id: string;
  owner_id: string;
  account_id: string;
  account_name: string;
  platform: PlatformId;
  text_override: string | null;
  /** JSON object. */
  options: string;
  status: TargetStatus;
  attempts: number;
  run_at: number;
  lease_until: number | null;
  progress: string | null;
  error: string | null;
  remote_id: string | null;
  remote_url: string | null;
  started_at: number | null;
  finished_at: number | null;
  created_at: number;
  updated_at: number;
}
