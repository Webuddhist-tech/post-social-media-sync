import crypto from "node:crypto";

export function newId(): string {
  return crypto.randomUUID();
}

export interface TableNames {
  accounts: string;
  states: string;
  media: string;
  posts: string;
  postMedia: string;
  targets: string;
}

/**
 * oauth_states columns added after the table was first released. Existing tables get them in `migrate()`
 * (Postgres: in the schema below; SQLite has no ADD COLUMN IF NOT EXISTS, so its storage checks first).
 */
export const STATE_COLUMNS_ADDED = ["binding", "callback_query"] as const;

/** Schema shared by the SQLite and PostgreSQL storages (timestamps are epoch milliseconds). */
export function schemaSql(t: TableNames, dialect: "sqlite" | "postgres"): string {
  const int = dialect === "postgres" ? "BIGINT" : "INTEGER";
  const real = dialect === "postgres" ? "DOUBLE PRECISION" : "REAL";
  // Index names can't be schema-qualified (Postgres puts an index in its table's schema).
  const ix = (table: string, suffix: string) => `${table.slice(table.lastIndexOf(".") + 1)}_${suffix}`;
  return `
CREATE TABLE IF NOT EXISTS ${t.accounts} (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  connector TEXT NOT NULL,
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  username TEXT,
  avatar_url TEXT,
  credentials TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  grant_id TEXT,
  expires_at ${int},
  status TEXT NOT NULL DEFAULT 'active',
  status_message TEXT,
  created_at ${int} NOT NULL,
  updated_at ${int} NOT NULL,
  UNIQUE (owner_id, platform, external_id)
);
CREATE INDEX IF NOT EXISTS ${ix(t.accounts, "owner")} ON ${t.accounts} (owner_id);

CREATE TABLE IF NOT EXISTS ${t.states} (
  state TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  connector TEXT NOT NULL,
  code_verifier TEXT,
  return_to TEXT,
  binding TEXT,
  callback_query TEXT,
  created_at ${int} NOT NULL
);
${dialect === "postgres" ? STATE_COLUMNS_ADDED.map((c) => `ALTER TABLE ${t.states} ADD COLUMN IF NOT EXISTS ${c} TEXT;\n`).join("") : ""}
CREATE TABLE IF NOT EXISTS ${t.media} (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  file TEXT NOT NULL,
  mime TEXT NOT NULL,
  kind TEXT NOT NULL,
  size ${int} NOT NULL,
  width ${int},
  height ${int},
  duration ${real},
  created_at ${int} NOT NULL
);
CREATE INDEX IF NOT EXISTS ${ix(t.media, "owner")} ON ${t.media} (owner_id);

CREATE TABLE IF NOT EXISTS ${t.posts} (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  text TEXT NOT NULL,
  title TEXT,
  media_ids TEXT NOT NULL DEFAULT '[]',
  scheduled_at ${int},
  created_at ${int} NOT NULL
);
CREATE INDEX IF NOT EXISTS ${ix(t.posts, "owner_created")} ON ${t.posts} (owner_id, created_at);

CREATE TABLE IF NOT EXISTS ${t.postMedia} (
  post_id TEXT NOT NULL REFERENCES ${t.posts}(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL,
  position ${int} NOT NULL,
  PRIMARY KEY (post_id, media_id)
);
CREATE INDEX IF NOT EXISTS ${ix(t.postMedia, "media")} ON ${t.postMedia} (media_id);

CREATE TABLE IF NOT EXISTS ${t.targets} (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES ${t.posts}(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  account_name TEXT NOT NULL,
  platform TEXT NOT NULL,
  text_override TEXT,
  options TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  attempts ${int} NOT NULL DEFAULT 0,
  run_at ${int} NOT NULL,
  lease_until ${int},
  progress TEXT,
  error TEXT,
  remote_id TEXT,
  remote_url TEXT,
  started_at ${int},
  finished_at ${int},
  created_at ${int} NOT NULL,
  updated_at ${int} NOT NULL
);
CREATE INDEX IF NOT EXISTS ${ix(t.targets, "due")} ON ${t.targets} (status, run_at);
CREATE INDEX IF NOT EXISTS ${ix(t.targets, "post")} ON ${t.targets} (post_id);
CREATE INDEX IF NOT EXISTS ${ix(t.targets, "account")} ON ${t.targets} (account_id, status);
-- At most one running job per account, across every process sharing the database.
CREATE UNIQUE INDEX IF NOT EXISTS ${ix(t.targets, "one_running")} ON ${t.targets} (account_id) WHERE status = 'running';
`;
}
