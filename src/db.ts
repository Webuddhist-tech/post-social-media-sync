import Database from "better-sqlite3";
import crypto from "node:crypto";
import type { PlatformId } from "./platforms/types.js";

export type TargetStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface AccountRow {
  id: string;
  platform: PlatformId;
  connector: string;
  external_id: string;
  name: string;
  username: string | null;
  avatar_url: string | null;
  credentials: string;
  meta: string;
  expires_at: number | null;
  status: "active" | "needs_reauth";
  status_message: string | null;
  created_at: number;
  updated_at: number;
}

export interface MediaRow {
  id: string;
  filename: string;
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
  text: string;
  title: string | null;
  media_ids: string;
  scheduled_at: number | null;
  created_at: number;
}

export interface TargetRow {
  id: string;
  post_id: string;
  account_id: string;
  account_name: string;
  platform: PlatformId;
  text_override: string | null;
  options: string;
  status: TargetStatus;
  attempts: number;
  run_at: number;
  progress: string | null;
  error: string | null;
  remote_id: string | null;
  remote_url: string | null;
  started_at: number | null;
  finished_at: number | null;
  created_at: number;
  updated_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  connector TEXT NOT NULL,
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  username TEXT,
  avatar_url TEXT,
  credentials TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  status_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (platform, external_id)
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  connector TEXT NOT NULL,
  code_verifier TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  file TEXT NOT NULL,
  mime TEXT NOT NULL,
  kind TEXT NOT NULL,
  size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  duration REAL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  title TEXT,
  media_ids TEXT NOT NULL DEFAULT '[]',
  scheduled_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS post_targets (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  account_name TEXT NOT NULL,
  platform TEXT NOT NULL,
  text_override TEXT,
  options TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  run_at INTEGER NOT NULL,
  progress TEXT,
  error TEXT,
  remote_id TEXT,
  remote_url TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS post_targets_due ON post_targets (status, run_at);
CREATE INDEX IF NOT EXISTS post_targets_post ON post_targets (post_id);
`;

export function newId(): string {
  return crypto.randomUUID();
}

export type DB = ReturnType<typeof openDatabase>;

export function openDatabase(file: string) {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);

  const now = () => Date.now();

  return {
    raw: db,
    close: () => db.close(),

    // ---- accounts -------------------------------------------------------
    listAccounts(): AccountRow[] {
      return db.prepare("SELECT * FROM accounts ORDER BY platform, name").all() as AccountRow[];
    },
    getAccount(id: string): AccountRow | undefined {
      return db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | undefined;
    },
    /** Insert or update an account, keyed by (platform, external_id). Returns the account id. */
    upsertAccount(a: Omit<AccountRow, "id" | "created_at" | "updated_at" | "status" | "status_message">): string {
      const existing = db
        .prepare("SELECT id FROM accounts WHERE platform = ? AND external_id = ?")
        .get(a.platform, a.external_id) as { id: string } | undefined;
      const t = now();
      if (existing) {
        db.prepare(
          `UPDATE accounts SET connector = ?, name = ?, username = ?, avatar_url = ?, credentials = ?, meta = ?,
             expires_at = ?, status = 'active', status_message = NULL, updated_at = ? WHERE id = ?`,
        ).run(a.connector, a.name, a.username, a.avatar_url, a.credentials, a.meta, a.expires_at, t, existing.id);
        return existing.id;
      }
      const id = newId();
      db.prepare(
        `INSERT INTO accounts (id, platform, connector, external_id, name, username, avatar_url, credentials, meta,
           expires_at, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).run(id, a.platform, a.connector, a.external_id, a.name, a.username, a.avatar_url, a.credentials, a.meta, a.expires_at, t, t);
      return id;
    },
    updateAccountCredentials(id: string, credentials: string, expiresAt: number | null): void {
      db.prepare("UPDATE accounts SET credentials = ?, expires_at = ?, status = 'active', status_message = NULL, updated_at = ? WHERE id = ?").run(
        credentials,
        expiresAt,
        now(),
        id,
      );
    },
    markAccountNeedsReauth(id: string, message: string): void {
      db.prepare("UPDATE accounts SET status = 'needs_reauth', status_message = ?, updated_at = ? WHERE id = ?").run(message, now(), id);
    },
    deleteAccount(id: string): boolean {
      return db.prepare("DELETE FROM accounts WHERE id = ?").run(id).changes > 0;
    },

    // ---- oauth state ----------------------------------------------------
    saveOAuthState(state: string, connector: string, codeVerifier: string | null): void {
      db.prepare("DELETE FROM oauth_states WHERE created_at < ?").run(now() - 30 * 60_000);
      db.prepare("INSERT INTO oauth_states (state, connector, code_verifier, created_at) VALUES (?, ?, ?, ?)").run(
        state,
        connector,
        codeVerifier,
        now(),
      );
    },
    /** Returns and deletes the state (single use). Expires after 30 minutes. */
    takeOAuthState(state: string): { connector: string; code_verifier: string | null } | undefined {
      const row = db.prepare("SELECT * FROM oauth_states WHERE state = ?").get(state) as
        | { connector: string; code_verifier: string | null; created_at: number }
        | undefined;
      if (!row) return undefined;
      db.prepare("DELETE FROM oauth_states WHERE state = ?").run(state);
      if (row.created_at < now() - 30 * 60_000) return undefined;
      return row;
    },

    // ---- media ----------------------------------------------------------
    insertMedia(m: MediaRow): void {
      db.prepare(
        `INSERT INTO media (id, filename, file, mime, kind, size, width, height, duration, created_at)
         VALUES (@id, @filename, @file, @mime, @kind, @size, @width, @height, @duration, @created_at)`,
      ).run(m);
    },
    getMedia(id: string): MediaRow | undefined {
      return db.prepare("SELECT * FROM media WHERE id = ?").get(id) as MediaRow | undefined;
    },
    getMediaByFile(file: string): MediaRow | undefined {
      return db.prepare("SELECT * FROM media WHERE file = ?").get(file) as MediaRow | undefined;
    },
    deleteMedia(id: string): void {
      db.prepare("DELETE FROM media WHERE id = ?").run(id);
    },
    isMediaReferenced(id: string): boolean {
      return !!db.prepare("SELECT 1 FROM posts p, json_each(p.media_ids) j WHERE j.value = ? LIMIT 1").get(id);
    },
    /** Media that no post references, older than `olderThan` (ms epoch). */
    orphanMedia(olderThan: number): MediaRow[] {
      return db
        .prepare(
          `SELECT m.* FROM media m WHERE m.created_at < ?
             AND NOT EXISTS (SELECT 1 FROM posts p, json_each(p.media_ids) j WHERE j.value = m.id)`,
        )
        .all(olderThan) as MediaRow[];
    },

    // ---- posts ----------------------------------------------------------
    insertPost(p: PostRow, targets: Omit<TargetRow, "created_at" | "updated_at">[]): void {
      const t = now();
      db.transaction(() => {
        db.prepare(
          "INSERT INTO posts (id, text, title, media_ids, scheduled_at, created_at) VALUES (@id, @text, @title, @media_ids, @scheduled_at, @created_at)",
        ).run(p);
        const ins = db.prepare(
          `INSERT INTO post_targets (id, post_id, account_id, account_name, platform, text_override, options, status, attempts,
             run_at, progress, error, remote_id, remote_url, started_at, finished_at, created_at, updated_at)
           VALUES (@id, @post_id, @account_id, @account_name, @platform, @text_override, @options, @status, @attempts,
             @run_at, @progress, @error, @remote_id, @remote_url, @started_at, @finished_at, ${t}, ${t})`,
        );
        for (const target of targets) ins.run(target);
      })();
    },
    getPost(id: string): PostRow | undefined {
      return db.prepare("SELECT * FROM posts WHERE id = ?").get(id) as PostRow | undefined;
    },
    listPosts(limit: number, before?: number): PostRow[] {
      if (before) {
        return db.prepare("SELECT * FROM posts WHERE created_at < ? ORDER BY created_at DESC LIMIT ?").all(before, limit) as PostRow[];
      }
      return db.prepare("SELECT * FROM posts ORDER BY created_at DESC LIMIT ?").all(limit) as PostRow[];
    },
    deletePost(id: string): boolean {
      return db.prepare("DELETE FROM posts WHERE id = ?").run(id).changes > 0;
    },
    targetsForPosts(postIds: string[]): TargetRow[] {
      if (postIds.length === 0) return [];
      const placeholders = postIds.map(() => "?").join(",");
      return db
        .prepare(`SELECT * FROM post_targets WHERE post_id IN (${placeholders}) ORDER BY created_at, platform, account_name`)
        .all(...postIds) as TargetRow[];
    },
    getTarget(id: string): TargetRow | undefined {
      return db.prepare("SELECT * FROM post_targets WHERE id = ?").get(id) as TargetRow | undefined;
    },

    // ---- queue ----------------------------------------------------------
    /** Atomically claims up to `limit` due targets, marking them running. */
    claimDueTargets(limit: number, excludeAccountIds: string[]): TargetRow[] {
      return db.transaction(() => {
        const t = now();
        const exclude = excludeAccountIds.length ? `AND account_id NOT IN (${excludeAccountIds.map(() => "?").join(",")})` : "";
        const rows = db
          .prepare(`SELECT * FROM post_targets WHERE status = 'queued' AND run_at <= ? ${exclude} ORDER BY run_at LIMIT ?`)
          .all(t, ...excludeAccountIds, limit * 4) as TargetRow[];
        // Only one job per account at a time: platforms dislike parallel uploads from one account.
        const seen = new Set<string>();
        const picked: TargetRow[] = [];
        for (const r of rows) {
          if (seen.has(r.account_id)) continue;
          seen.add(r.account_id);
          picked.push(r);
          if (picked.length >= limit) break;
        }
        const upd = db.prepare(
          "UPDATE post_targets SET status = 'running', attempts = attempts + 1, started_at = ?, progress = 'Starting…', error = NULL, updated_at = ? WHERE id = ?",
        );
        for (const r of picked) {
          upd.run(t, t, r.id);
          r.status = "running";
          r.attempts += 1;
        }
        return picked;
      })();
    },
    setTargetProgress(id: string, progress: string): void {
      db.prepare("UPDATE post_targets SET progress = ?, updated_at = ? WHERE id = ?").run(progress, now(), id);
    },
    completeTarget(id: string, remoteId: string, remoteUrl: string | null, note: string | null): void {
      const t = now();
      db.prepare(
        "UPDATE post_targets SET status = 'succeeded', remote_id = ?, remote_url = ?, progress = ?, error = NULL, finished_at = ?, updated_at = ? WHERE id = ?",
      ).run(remoteId, remoteUrl, note, t, t, id);
    },
    failTarget(id: string, error: string, retryAt: number | null): void {
      const t = now();
      if (retryAt) {
        db.prepare("UPDATE post_targets SET status = 'queued', run_at = ?, error = ?, progress = NULL, updated_at = ? WHERE id = ?").run(
          retryAt,
          error,
          t,
          id,
        );
      } else {
        db.prepare("UPDATE post_targets SET status = 'failed', error = ?, progress = NULL, finished_at = ?, updated_at = ? WHERE id = ?").run(
          error,
          t,
          t,
          id,
        );
      }
    },
    retryTarget(id: string): boolean {
      const t = now();
      return (
        db
          .prepare(
            "UPDATE post_targets SET status = 'queued', run_at = ?, attempts = 0, error = NULL, progress = NULL, finished_at = NULL, updated_at = ? WHERE id = ? AND status IN ('failed', 'cancelled')",
          )
          .run(t, t, id).changes > 0
      );
    },
    cancelTarget(id: string): boolean {
      const t = now();
      return (
        db
          .prepare("UPDATE post_targets SET status = 'cancelled', progress = NULL, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'")
          .run(t, t, id).changes > 0
      );
    },
    /** Jobs left "running" by a crash/restart. We don't retry them blindly: the post may already be live. */
    failInterruptedTargets(): number {
      const t = now();
      return db
        .prepare(
          "UPDATE post_targets SET status = 'failed', error = 'Interrupted because the server restarted. Check the platform before retrying, the post may already be live.', progress = NULL, finished_at = ?, updated_at = ? WHERE status = 'running'",
        )
        .run(t, t).changes;
    },
    hasActiveTargetsForAccount(accountId: string): boolean {
      return !!db.prepare("SELECT 1 FROM post_targets WHERE account_id = ? AND status IN ('queued', 'running') LIMIT 1").get(accountId);
    },
  };
}
