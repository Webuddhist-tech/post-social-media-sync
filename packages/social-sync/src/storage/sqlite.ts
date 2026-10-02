import Database from "better-sqlite3";
import type { AccountRow, MediaRow, NewAccount, OAuthStateRow, PostRow, Storage, TargetRow } from "./types.js";
import { newId, schemaSql } from "./schema.js";

export interface SqliteStorageOptions {
  /** Prefix for table names (default "postsync_"), so the tables can live next to yours. */
  tablePrefix?: string;
}

/**
 * SQLite storage (via better-sqlite3). Good for a single server process. Use PostgreSQL storage when several
 * processes or servers run the engine.
 *
 * @param file Path of the database file, or ":memory:".
 */
export function sqliteStorage(file: string, options: SqliteStorageOptions = {}): Storage {
  return new SqliteStorage(new Database(file), options.tablePrefix ?? "postsync_");
}

class SqliteStorage implements Storage {
  private readonly t: { accounts: string; states: string; media: string; posts: string; postMedia: string; targets: string };

  constructor(
    private readonly db: Database.Database,
    prefix: string,
  ) {
    if (!/^[a-z0-9_]*$/i.test(prefix)) throw new Error("tablePrefix may only contain letters, digits and _");
    this.t = {
      accounts: `${prefix}accounts`,
      states: `${prefix}oauth_states`,
      media: `${prefix}media`,
      posts: `${prefix}posts`,
      postMedia: `${prefix}post_media`,
      targets: `${prefix}targets`,
    };
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
  }

  async migrate(): Promise<void> {
    this.db.exec(schemaSql(this.t, "sqlite"));
  }

  async close(): Promise<void> {
    this.db.close();
  }

  // ---- accounts ---------------------------------------------------------------------

  async listAccounts(ownerId: string): Promise<AccountRow[]> {
    return this.db.prepare(`SELECT * FROM ${this.t.accounts} WHERE owner_id = ? ORDER BY platform, name`).all(ownerId) as AccountRow[];
  }

  async getAccount(ownerId: string | null, id: string): Promise<AccountRow | undefined> {
    return ownerId === null
      ? (this.db.prepare(`SELECT * FROM ${this.t.accounts} WHERE id = ?`).get(id) as AccountRow | undefined)
      : (this.db.prepare(`SELECT * FROM ${this.t.accounts} WHERE id = ? AND owner_id = ?`).get(id, ownerId) as AccountRow | undefined);
  }

  async upsertAccount(a: NewAccount): Promise<string> {
    const now = Date.now();
    const existing = this.db
      .prepare(`SELECT id FROM ${this.t.accounts} WHERE owner_id = ? AND platform = ? AND external_id = ?`)
      .get(a.owner_id, a.platform, a.external_id) as { id: string } | undefined;
    if (existing) {
      this.db
        .prepare(
          `UPDATE ${this.t.accounts} SET connector = ?, name = ?, username = ?, avatar_url = ?, credentials = ?, meta = ?, grant_id = ?,
             expires_at = ?, status = 'active', status_message = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(a.connector, a.name, a.username, a.avatar_url, a.credentials, a.meta, a.grant_id, a.expires_at, now, existing.id);
      return existing.id;
    }
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO ${this.t.accounts} (id, owner_id, platform, connector, external_id, name, username, avatar_url, credentials, meta,
           grant_id, expires_at, status, status_message, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)`,
      )
      .run(id, a.owner_id, a.platform, a.connector, a.external_id, a.name, a.username, a.avatar_url, a.credentials, a.meta, a.grant_id, a.expires_at, now, now);
    return id;
  }

  async updateAccountCredentials(id: string, credentials: string, expiresAt: number | null): Promise<void> {
    this.db
      .prepare(`UPDATE ${this.t.accounts} SET credentials = ?, expires_at = ?, status = 'active', status_message = NULL, updated_at = ? WHERE id = ?`)
      .run(credentials, expiresAt, Date.now(), id);
  }

  async setAccountStatus(id: string, status: AccountRow["status"], message: string | null): Promise<void> {
    this.db.prepare(`UPDATE ${this.t.accounts} SET status = ?, status_message = ?, updated_at = ? WHERE id = ?`).run(status, message, Date.now(), id);
  }

  async deleteAccount(ownerId: string, id: string): Promise<boolean> {
    return this.db.prepare(`DELETE FROM ${this.t.accounts} WHERE id = ? AND owner_id = ?`).run(id, ownerId).changes > 0;
  }

  async accountsByGrant(ownerId: string, connector: string, grantId: string): Promise<AccountRow[]> {
    return this.db
      .prepare(`SELECT * FROM ${this.t.accounts} WHERE owner_id = ? AND connector = ? AND grant_id = ?`)
      .all(ownerId, connector, grantId) as AccountRow[];
  }

  async accountsExpiringBefore(before: number): Promise<AccountRow[]> {
    return this.db
      .prepare(`SELECT * FROM ${this.t.accounts} WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < ?`)
      .all(before) as AccountRow[];
  }

  // ---- OAuth state ------------------------------------------------------------------------

  async saveOAuthState(row: OAuthStateRow): Promise<void> {
    this.db.prepare(`DELETE FROM ${this.t.states} WHERE created_at < ?`).run(Date.now() - 24 * 3600_000);
    this.db
      .prepare(`INSERT INTO ${this.t.states} (state, owner_id, connector, code_verifier, return_to, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(row.state, row.owner_id, row.connector, row.code_verifier, row.return_to, row.created_at);
  }

  async takeOAuthState(state: string, notOlderThan: number): Promise<OAuthStateRow | undefined> {
    return this.db.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM ${this.t.states} WHERE state = ?`).get(state) as OAuthStateRow | undefined;
      if (!row) return undefined;
      this.db.prepare(`DELETE FROM ${this.t.states} WHERE state = ?`).run(state);
      return row.created_at >= notOlderThan ? row : undefined;
    }).immediate();
  }

  // ---- media -------------------------------------------------------------------------------

  async insertMedia(m: MediaRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO ${this.t.media} (id, owner_id, filename, file, mime, kind, size, width, height, duration, created_at)
         VALUES (@id, @owner_id, @filename, @file, @mime, @kind, @size, @width, @height, @duration, @created_at)`,
      )
      .run(m);
  }

  async getMedia(ownerId: string | null, id: string): Promise<MediaRow | undefined> {
    return ownerId === null
      ? (this.db.prepare(`SELECT * FROM ${this.t.media} WHERE id = ?`).get(id) as MediaRow | undefined)
      : (this.db.prepare(`SELECT * FROM ${this.t.media} WHERE id = ? AND owner_id = ?`).get(id, ownerId) as MediaRow | undefined);
  }

  async deleteMedia(id: string): Promise<void> {
    this.db.prepare(`DELETE FROM ${this.t.media} WHERE id = ?`).run(id);
  }

  async isMediaReferenced(id: string): Promise<boolean> {
    return !!this.db.prepare(`SELECT 1 FROM ${this.t.postMedia} WHERE media_id = ? LIMIT 1`).get(id);
  }

  async orphanMedia(olderThan: number): Promise<MediaRow[]> {
    return this.db
      .prepare(`SELECT m.* FROM ${this.t.media} m WHERE m.created_at < ? AND NOT EXISTS (SELECT 1 FROM ${this.t.postMedia} pm WHERE pm.media_id = m.id)`)
      .all(olderThan) as MediaRow[];
  }

  // ---- posts ---------------------------------------------------------------------------------

  async insertPost(p: PostRow, targets: TargetRow[]): Promise<void> {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO ${this.t.posts} (id, owner_id, text, title, media_ids, scheduled_at, created_at)
           VALUES (@id, @owner_id, @text, @title, @media_ids, @scheduled_at, @created_at)`,
        )
        .run(p);
      const link = this.db.prepare(`INSERT INTO ${this.t.postMedia} (post_id, media_id, position) VALUES (?, ?, ?)`);
      (JSON.parse(p.media_ids) as string[]).forEach((mediaId, i) => link.run(p.id, mediaId, i));
      const ins = this.db.prepare(
        `INSERT INTO ${this.t.targets} (id, post_id, owner_id, account_id, account_name, platform, text_override, options, status, attempts,
           run_at, lease_until, progress, error, remote_id, remote_url, started_at, finished_at, created_at, updated_at)
         VALUES (@id, @post_id, @owner_id, @account_id, @account_name, @platform, @text_override, @options, @status, @attempts,
           @run_at, @lease_until, @progress, @error, @remote_id, @remote_url, @started_at, @finished_at, @created_at, @updated_at)`,
      );
      for (const target of targets) ins.run(target);
    })();
  }

  async getPost(ownerId: string | null, id: string): Promise<PostRow | undefined> {
    return ownerId === null
      ? (this.db.prepare(`SELECT * FROM ${this.t.posts} WHERE id = ?`).get(id) as PostRow | undefined)
      : (this.db.prepare(`SELECT * FROM ${this.t.posts} WHERE id = ? AND owner_id = ?`).get(id, ownerId) as PostRow | undefined);
  }

  async listPosts(ownerId: string, limit: number, before?: number): Promise<PostRow[]> {
    if (before !== undefined) {
      return this.db
        .prepare(`SELECT * FROM ${this.t.posts} WHERE owner_id = ? AND created_at < ? ORDER BY created_at DESC, id DESC LIMIT ?`)
        .all(ownerId, before, limit) as PostRow[];
    }
    return this.db.prepare(`SELECT * FROM ${this.t.posts} WHERE owner_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`).all(ownerId, limit) as PostRow[];
  }

  async deletePost(ownerId: string, id: string): Promise<boolean> {
    return this.db.prepare(`DELETE FROM ${this.t.posts} WHERE id = ? AND owner_id = ?`).run(id, ownerId).changes > 0;
  }

  async targetsForPosts(postIds: string[]): Promise<TargetRow[]> {
    if (postIds.length === 0) return [];
    const placeholders = postIds.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT * FROM ${this.t.targets} WHERE post_id IN (${placeholders}) ORDER BY created_at, platform, account_name`)
      .all(...postIds) as TargetRow[];
  }

  async getTarget(ownerId: string | null, id: string): Promise<TargetRow | undefined> {
    return ownerId === null
      ? (this.db.prepare(`SELECT * FROM ${this.t.targets} WHERE id = ?`).get(id) as TargetRow | undefined)
      : (this.db.prepare(`SELECT * FROM ${this.t.targets} WHERE id = ? AND owner_id = ?`).get(id, ownerId) as TargetRow | undefined);
  }

  async hasActiveTargetsForAccount(accountId: string): Promise<boolean> {
    return !!this.db.prepare(`SELECT 1 FROM ${this.t.targets} WHERE account_id = ? AND status IN ('queued', 'running') LIMIT 1`).get(accountId);
  }

  // ---- queue -------------------------------------------------------------------------------------

  async claimDueTargets(limit: number, now: number, leaseUntil: number): Promise<TargetRow[]> {
    // BEGIN IMMEDIATE: take the write lock first, so two processes never claim from the same snapshot.
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT * FROM ${this.t.targets} t WHERE t.status = 'queued' AND t.run_at <= ?
             AND NOT EXISTS (SELECT 1 FROM ${this.t.targets} r WHERE r.account_id = t.account_id AND r.status = 'running')
           ORDER BY t.run_at LIMIT ?`,
        )
        .all(now, limit * 4) as TargetRow[];
      const seen = new Set<string>();
      const picked: TargetRow[] = [];
      const claim = this.db.prepare(
        `UPDATE ${this.t.targets} SET status = 'running', attempts = attempts + 1, lease_until = ?, started_at = ?, progress = 'Starting…',
           error = NULL, updated_at = ? WHERE id = ? AND status = 'queued'`,
      );
      for (const r of rows) {
        if (seen.has(r.account_id)) continue;
        seen.add(r.account_id);
        if (claim.run(leaseUntil, now, now, r.id).changes === 0) continue;
        picked.push({ ...r, status: "running", attempts: r.attempts + 1, lease_until: leaseUntil, started_at: now, progress: "Starting…", error: null });
        if (picked.length >= limit) break;
      }
      return picked;
    }).immediate();
  }

  async renewLeases(ids: string[], leaseUntil: number): Promise<void> {
    if (!ids.length) return;
    this.db
      .prepare(`UPDATE ${this.t.targets} SET lease_until = ? WHERE status = 'running' AND id IN (${ids.map(() => "?").join(",")})`)
      .run(leaseUntil, ...ids);
  }

  async setTargetProgress(id: string, progress: string): Promise<void> {
    this.db.prepare(`UPDATE ${this.t.targets} SET progress = ?, updated_at = ? WHERE id = ?`).run(progress, Date.now(), id);
  }

  async completeTarget(id: string, remoteId: string, remoteUrl: string | null, note: string | null): Promise<void> {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE ${this.t.targets} SET status = 'succeeded', remote_id = ?, remote_url = ?, progress = ?, error = NULL, lease_until = NULL,
           finished_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(remoteId, remoteUrl, note, now, now, id);
  }

  async failTarget(id: string, error: string, retryAt: number | null): Promise<void> {
    const now = Date.now();
    if (retryAt) {
      this.db
        .prepare(`UPDATE ${this.t.targets} SET status = 'queued', run_at = ?, error = ?, progress = NULL, lease_until = NULL, updated_at = ? WHERE id = ?`)
        .run(retryAt, error, now, id);
    } else {
      this.db
        .prepare(
          `UPDATE ${this.t.targets} SET status = 'failed', error = ?, progress = NULL, lease_until = NULL, finished_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(error, now, now, id);
    }
  }

  async retryTarget(ownerId: string, id: string): Promise<boolean> {
    const now = Date.now();
    return (
      this.db
        .prepare(
          `UPDATE ${this.t.targets} SET status = 'queued', run_at = ?, attempts = 0, error = NULL, progress = NULL, finished_at = NULL, updated_at = ?
           WHERE id = ? AND owner_id = ? AND status IN ('failed', 'cancelled')`,
        )
        .run(now, now, id, ownerId).changes > 0
    );
  }

  async cancelTarget(ownerId: string, id: string): Promise<boolean> {
    const now = Date.now();
    return (
      this.db
        .prepare(
          `UPDATE ${this.t.targets} SET status = 'cancelled', progress = NULL, finished_at = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND status = 'queued'`,
        )
        .run(now, now, id, ownerId).changes > 0
    );
  }

  async failExpiredLeases(now: number, message: string): Promise<TargetRow[]> {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(`SELECT * FROM ${this.t.targets} WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until < ?`)
        .all(now) as TargetRow[];
      const upd = this.db.prepare(
        `UPDATE ${this.t.targets} SET status = 'failed', error = ?, progress = NULL, lease_until = NULL, finished_at = ?, updated_at = ? WHERE id = ?`,
      );
      for (const r of rows) upd.run(message, now, now, r.id);
      return rows.map((r) => ({ ...r, status: "failed" as const, error: message, progress: null, lease_until: null, finished_at: now }));
    }).immediate();
  }
}
