import type { AccountRow, MediaRow, NewAccount, OAuthStateRow, PostRow, Storage, TargetRow } from "./types.js";
import { newId, schemaSql, type TableNames } from "./schema.js";

/** The part of a `pg` client this storage uses. */
export interface PgQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

/** The part of a `pg.Pool` this storage uses. */
export interface PgPoolLike extends PgQueryable {
  connect(): Promise<PgQueryable & { release(err?: Error | boolean): void }>;
  end?(): Promise<void>;
}

export interface PostgresStorageOptions {
  /** Prefix for table names (default "postsync_"), so the tables can live next to yours. */
  tablePrefix?: string;
  /** Postgres schema to create the tables in (default: the connection's search_path, usually "public"). */
  schema?: string;
}

/**
 * PostgreSQL storage. Safe for several processes or servers running the engine against one database.
 *
 * @param pool A `pg.Pool` you already have (shared with your app), or a connection string (a pool is created and
 *   closed by the storage; needs the `pg` package installed).
 */
export function postgresStorage(pool: PgPoolLike | string, options: PostgresStorageOptions = {}): Storage {
  return new PostgresStorage(pool, options);
}

const NUMERIC = new Set([
  "expires_at",
  "created_at",
  "updated_at",
  "size",
  "width",
  "height",
  "duration",
  "scheduled_at",
  "attempts",
  "run_at",
  "lease_until",
  "started_at",
  "finished_at",
]);

/** pg returns BIGINT as strings; the rest of the engine expects numbers (epoch milliseconds fit safely). */
function fix<T>(row: any): T {
  for (const key of Object.keys(row)) {
    const v = row[key];
    if (NUMERIC.has(key) && v !== null && typeof v !== "number") row[key] = Number(v);
  }
  return row as T;
}
const fixAll = <T>(rows: any[]): T[] => rows.map((r) => fix<T>(r));

const IDENT = /^[a-z_][a-z0-9_]*$/i;

class PostgresStorage implements Storage {
  private readonly t: TableNames;
  private readonly lockKey: string;
  private poolPromise: Promise<PgPoolLike> | null = null;
  private readonly ownsPool: boolean;

  constructor(
    private readonly source: PgPoolLike | string,
    options: PostgresStorageOptions,
  ) {
    const prefix = options.tablePrefix ?? "postsync_";
    if (!/^[a-z0-9_]*$/i.test(prefix)) throw new Error("tablePrefix may only contain letters, digits and _");
    if (options.schema !== undefined && !IDENT.test(options.schema)) throw new Error("schema must be a plain identifier");
    const q = options.schema ? `${options.schema}.` : "";
    this.t = {
      accounts: `${q}${prefix}accounts`,
      states: `${q}${prefix}oauth_states`,
      media: `${q}${prefix}media`,
      posts: `${q}${prefix}posts`,
      postMedia: `${q}${prefix}post_media`,
      targets: `${q}${prefix}targets`,
    };
    this.lockKey = `${q}${prefix}`;
    this.ownsPool = typeof source === "string";
  }

  private pool(): Promise<PgPoolLike> {
    if (!this.poolPromise) {
      const source = this.source;
      this.poolPromise =
        typeof source === "string"
          ? import("pg").then((mod: any) => new (mod.default?.Pool ?? mod.Pool)({ connectionString: source }) as PgPoolLike)
          : Promise.resolve(source);
    }
    return this.poolPromise;
  }

  private async query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> {
    return (await this.pool()).query(text, values);
  }

  /** Runs `fn` in a transaction holding a lock that serializes it with the same kind of transaction elsewhere. */
  private async locked<T>(lock: string, fn: (client: PgQueryable) => Promise<T>): Promise<T> {
    const client = await (await this.pool()).connect();
    let broken = false;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${this.lockKey}${lock}`]);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {
        broken = true;
      });
      throw err;
    } finally {
      client.release(broken);
    }
  }

  async migrate(): Promise<void> {
    if (this.t.accounts.includes(".")) {
      await this.query(`CREATE SCHEMA IF NOT EXISTS ${this.t.accounts.split(".")[0]}`);
    }
    // Several processes may start at once: CREATE ... IF NOT EXISTS isn't safe against itself without a lock.
    await this.locked("migrate", async (client) => {
      for (const statement of schemaSql(this.t, "postgres").split(/;\s*\n/)) {
        if (statement.replace(/--.*$/gm, "").trim()) await client.query(statement);
      }
    });
  }

  async close(): Promise<void> {
    if (this.ownsPool && this.poolPromise) await (await this.poolPromise).end?.();
  }

  // ---- accounts ---------------------------------------------------------------------

  async listAccounts(ownerId: string): Promise<AccountRow[]> {
    return fixAll((await this.query(`SELECT * FROM ${this.t.accounts} WHERE owner_id = $1 ORDER BY platform, name`, [ownerId])).rows);
  }

  async getAccount(ownerId: string | null, id: string): Promise<AccountRow | undefined> {
    const { rows } =
      ownerId === null
        ? await this.query(`SELECT * FROM ${this.t.accounts} WHERE id = $1`, [id])
        : await this.query(`SELECT * FROM ${this.t.accounts} WHERE id = $1 AND owner_id = $2`, [id, ownerId]);
    return rows[0] ? fix(rows[0]) : undefined;
  }

  async upsertAccount(a: NewAccount): Promise<string> {
    const now = Date.now();
    const { rows } = await this.query(
      `INSERT INTO ${this.t.accounts} (id, owner_id, platform, connector, external_id, name, username, avatar_url, credentials, meta,
         grant_id, expires_at, status, status_message, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'active', NULL, $13, $13)
       ON CONFLICT (owner_id, platform, external_id) DO UPDATE SET
         connector = EXCLUDED.connector, name = EXCLUDED.name, username = EXCLUDED.username, avatar_url = EXCLUDED.avatar_url,
         credentials = EXCLUDED.credentials, meta = EXCLUDED.meta, grant_id = EXCLUDED.grant_id, expires_at = EXCLUDED.expires_at,
         status = 'active', status_message = NULL, updated_at = EXCLUDED.updated_at
       RETURNING id`,
      [newId(), a.owner_id, a.platform, a.connector, a.external_id, a.name, a.username, a.avatar_url, a.credentials, a.meta, a.grant_id, a.expires_at, now],
    );
    return rows[0].id;
  }

  async updateAccountCredentials(id: string, credentials: string, expiresAt: number | null): Promise<void> {
    await this.query(
      `UPDATE ${this.t.accounts} SET credentials = $1, expires_at = $2, status = 'active', status_message = NULL, updated_at = $3 WHERE id = $4`,
      [credentials, expiresAt, Date.now(), id],
    );
  }

  async setAccountStatus(id: string, status: AccountRow["status"], message: string | null): Promise<void> {
    await this.query(`UPDATE ${this.t.accounts} SET status = $1, status_message = $2, updated_at = $3 WHERE id = $4`, [status, message, Date.now(), id]);
  }

  async deleteAccount(ownerId: string, id: string): Promise<boolean> {
    return ((await this.query(`DELETE FROM ${this.t.accounts} WHERE id = $1 AND owner_id = $2`, [id, ownerId])).rowCount ?? 0) > 0;
  }

  async accountsByGrant(ownerId: string, connector: string, grantId: string): Promise<AccountRow[]> {
    return fixAll(
      (await this.query(`SELECT * FROM ${this.t.accounts} WHERE owner_id = $1 AND connector = $2 AND grant_id = $3`, [ownerId, connector, grantId])).rows,
    );
  }

  async accountsExpiringBefore(before: number): Promise<AccountRow[]> {
    return fixAll(
      (await this.query(`SELECT * FROM ${this.t.accounts} WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < $1`, [before])).rows,
    );
  }

  // ---- OAuth state ------------------------------------------------------------------------

  async saveOAuthState(row: OAuthStateRow): Promise<void> {
    await this.query(`DELETE FROM ${this.t.states} WHERE created_at < $1`, [Date.now() - 24 * 3600_000]);
    await this.query(
      `INSERT INTO ${this.t.states} (state, owner_id, connector, code_verifier, return_to, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [row.state, row.owner_id, row.connector, row.code_verifier, row.return_to, row.created_at],
    );
  }

  async takeOAuthState(state: string, notOlderThan: number): Promise<OAuthStateRow | undefined> {
    // DELETE ... RETURNING is atomic: only one caller gets the row.
    const { rows } = await this.query(`DELETE FROM ${this.t.states} WHERE state = $1 RETURNING *`, [state]);
    const row = rows[0] ? fix<OAuthStateRow>(rows[0]) : undefined;
    return row && row.created_at >= notOlderThan ? row : undefined;
  }

  // ---- media -------------------------------------------------------------------------------

  async insertMedia(m: MediaRow): Promise<void> {
    await this.query(
      `INSERT INTO ${this.t.media} (id, owner_id, filename, file, mime, kind, size, width, height, duration, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [m.id, m.owner_id, m.filename, m.file, m.mime, m.kind, m.size, m.width, m.height, m.duration, m.created_at],
    );
  }

  async getMedia(ownerId: string | null, id: string): Promise<MediaRow | undefined> {
    const { rows } =
      ownerId === null
        ? await this.query(`SELECT * FROM ${this.t.media} WHERE id = $1`, [id])
        : await this.query(`SELECT * FROM ${this.t.media} WHERE id = $1 AND owner_id = $2`, [id, ownerId]);
    return rows[0] ? fix(rows[0]) : undefined;
  }

  async deleteMedia(id: string): Promise<void> {
    await this.query(`DELETE FROM ${this.t.media} WHERE id = $1`, [id]);
  }

  async isMediaReferenced(id: string): Promise<boolean> {
    return (await this.query(`SELECT 1 FROM ${this.t.postMedia} WHERE media_id = $1 LIMIT 1`, [id])).rows.length > 0;
  }

  async orphanMedia(olderThan: number): Promise<MediaRow[]> {
    return fixAll(
      (
        await this.query(
          `SELECT m.* FROM ${this.t.media} m WHERE m.created_at < $1
             AND NOT EXISTS (SELECT 1 FROM ${this.t.postMedia} pm WHERE pm.media_id = m.id)`,
          [olderThan],
        )
      ).rows,
    );
  }

  // ---- posts ---------------------------------------------------------------------------------

  async insertPost(p: PostRow, targets: TargetRow[]): Promise<void> {
    const client = await (await this.pool()).connect();
    let broken = false;
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO ${this.t.posts} (id, owner_id, text, title, media_ids, scheduled_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [p.id, p.owner_id, p.text, p.title, p.media_ids, p.scheduled_at, p.created_at],
      );
      const mediaIds = JSON.parse(p.media_ids) as string[];
      for (let i = 0; i < mediaIds.length; i++) {
        await client.query(`INSERT INTO ${this.t.postMedia} (post_id, media_id, position) VALUES ($1, $2, $3)`, [p.id, mediaIds[i], i]);
      }
      for (const t of targets) {
        await client.query(
          `INSERT INTO ${this.t.targets} (id, post_id, owner_id, account_id, account_name, platform, text_override, options, status, attempts,
             run_at, lease_until, progress, error, remote_id, remote_url, started_at, finished_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
          [
            t.id,
            t.post_id,
            t.owner_id,
            t.account_id,
            t.account_name,
            t.platform,
            t.text_override,
            t.options,
            t.status,
            t.attempts,
            t.run_at,
            t.lease_until,
            t.progress,
            t.error,
            t.remote_id,
            t.remote_url,
            t.started_at,
            t.finished_at,
            t.created_at,
            t.updated_at,
          ],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {
        broken = true;
      });
      throw err;
    } finally {
      client.release(broken);
    }
  }

  async getPost(ownerId: string | null, id: string): Promise<PostRow | undefined> {
    const { rows } =
      ownerId === null
        ? await this.query(`SELECT * FROM ${this.t.posts} WHERE id = $1`, [id])
        : await this.query(`SELECT * FROM ${this.t.posts} WHERE id = $1 AND owner_id = $2`, [id, ownerId]);
    return rows[0] ? fix(rows[0]) : undefined;
  }

  async listPosts(ownerId: string, limit: number, before?: number): Promise<PostRow[]> {
    const { rows } =
      before !== undefined
        ? await this.query(
            `SELECT * FROM ${this.t.posts} WHERE owner_id = $1 AND created_at < $2 ORDER BY created_at DESC, id DESC LIMIT $3`,
            [ownerId, before, limit],
          )
        : await this.query(`SELECT * FROM ${this.t.posts} WHERE owner_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`, [ownerId, limit]);
    return fixAll(rows);
  }

  async deletePost(ownerId: string, id: string): Promise<boolean> {
    return ((await this.query(`DELETE FROM ${this.t.posts} WHERE id = $1 AND owner_id = $2`, [id, ownerId])).rowCount ?? 0) > 0;
  }

  async targetsForPosts(postIds: string[]): Promise<TargetRow[]> {
    if (postIds.length === 0) return [];
    return fixAll(
      (await this.query(`SELECT * FROM ${this.t.targets} WHERE post_id = ANY($1::text[]) ORDER BY created_at, platform, account_name`, [postIds])).rows,
    );
  }

  async getTarget(ownerId: string | null, id: string): Promise<TargetRow | undefined> {
    const { rows } =
      ownerId === null
        ? await this.query(`SELECT * FROM ${this.t.targets} WHERE id = $1`, [id])
        : await this.query(`SELECT * FROM ${this.t.targets} WHERE id = $1 AND owner_id = $2`, [id, ownerId]);
    return rows[0] ? fix(rows[0]) : undefined;
  }

  async hasActiveTargetsForAccount(accountId: string): Promise<boolean> {
    return (await this.query(`SELECT 1 FROM ${this.t.targets} WHERE account_id = $1 AND status IN ('queued', 'running') LIMIT 1`, [accountId])).rows.length > 0;
  }

  // ---- queue -------------------------------------------------------------------------------------

  async claimDueTargets(limit: number, now: number, leaseUntil: number): Promise<TargetRow[]> {
    // Claims are serialized across processes by an advisory lock, so the "no running job for this account" check
    // always sees the other processes' committed claims. Claiming is a single quick statement.
    return this.locked("claim", async (client) => {
      const { rows } = await client.query(
        `UPDATE ${this.t.targets} SET status = 'running', attempts = attempts + 1, lease_until = $1, started_at = $2, progress = 'Starting…',
           error = NULL, updated_at = $2
         WHERE id IN (
           SELECT id FROM (
             SELECT DISTINCT ON (t.account_id) t.id, t.run_at FROM ${this.t.targets} t
             WHERE t.status = 'queued' AND t.run_at <= $2
               AND NOT EXISTS (SELECT 1 FROM ${this.t.targets} r WHERE r.account_id = t.account_id AND r.status = 'running')
             ORDER BY t.account_id, t.run_at
           ) due ORDER BY run_at LIMIT $3
         ) AND status = 'queued'
         RETURNING *`,
        [leaseUntil, now, limit],
      );
      return fixAll<TargetRow>(rows).sort((a, b) => a.run_at - b.run_at);
    });
  }

  async renewLeases(ids: string[], leaseUntil: number): Promise<void> {
    if (!ids.length) return;
    await this.query(`UPDATE ${this.t.targets} SET lease_until = $1 WHERE status = 'running' AND id = ANY($2::text[])`, [leaseUntil, ids]);
  }

  async setTargetProgress(id: string, progress: string): Promise<void> {
    await this.query(`UPDATE ${this.t.targets} SET progress = $1, updated_at = $2 WHERE id = $3`, [progress, Date.now(), id]);
  }

  async completeTarget(id: string, remoteId: string, remoteUrl: string | null, note: string | null): Promise<void> {
    const now = Date.now();
    await this.query(
      `UPDATE ${this.t.targets} SET status = 'succeeded', remote_id = $1, remote_url = $2, progress = $3, error = NULL, lease_until = NULL,
         finished_at = $4, updated_at = $4 WHERE id = $5`,
      [remoteId, remoteUrl, note, now, id],
    );
  }

  async failTarget(id: string, error: string, retryAt: number | null): Promise<void> {
    const now = Date.now();
    if (retryAt) {
      await this.query(
        `UPDATE ${this.t.targets} SET status = 'queued', run_at = $1, error = $2, progress = NULL, lease_until = NULL, updated_at = $3 WHERE id = $4`,
        [retryAt, error, now, id],
      );
    } else {
      await this.query(
        `UPDATE ${this.t.targets} SET status = 'failed', error = $1, progress = NULL, lease_until = NULL, finished_at = $2, updated_at = $2 WHERE id = $3`,
        [error, now, id],
      );
    }
  }

  async retryTarget(ownerId: string, id: string): Promise<boolean> {
    const now = Date.now();
    const { rowCount } = await this.query(
      `UPDATE ${this.t.targets} SET status = 'queued', run_at = $1, attempts = 0, error = NULL, progress = NULL, finished_at = NULL, updated_at = $1
       WHERE id = $2 AND owner_id = $3 AND status IN ('failed', 'cancelled')`,
      [now, id, ownerId],
    );
    return (rowCount ?? 0) > 0;
  }

  async cancelTarget(ownerId: string, id: string): Promise<boolean> {
    const now = Date.now();
    const { rowCount } = await this.query(
      `UPDATE ${this.t.targets} SET status = 'cancelled', progress = NULL, finished_at = $1, updated_at = $1
       WHERE id = $2 AND owner_id = $3 AND status = 'queued'`,
      [now, id, ownerId],
    );
    return (rowCount ?? 0) > 0;
  }

  async failExpiredLeases(now: number, message: string): Promise<TargetRow[]> {
    // UPDATE ... RETURNING: each expired job is reported by exactly one process.
    const { rows } = await this.query(
      `UPDATE ${this.t.targets} SET status = 'failed', error = $1, progress = NULL, lease_until = NULL, finished_at = $2, updated_at = $2
       WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until < $2
       RETURNING *`,
      [message, now],
    );
    return fixAll(rows);
  }
}
