import type { Config } from "./config.js";
import { randomToken, type Secrets } from "./crypto.js";
import type { AccountRow, DB } from "./db.js";
import { AuthError } from "./http.js";
import { getConnector } from "./platforms/index.js";
import type { AccountDraft, AccountInfo, ConnectorId } from "./platforms/types.js";

/** Refresh access tokens this long before they expire. */
const REFRESH_MARGIN_MS = 5 * 60_000;

export interface PublicAccount {
  id: string;
  platform: string;
  connector: string;
  name: string;
  username: string | null;
  avatarUrl: string | null;
  status: "active" | "needs_reauth";
  statusMessage: string | null;
  expiresAt: number | null;
  createdAt: number;
}

export class AccountService {
  /** Serializes refreshes per account (X refresh tokens are single-use, so concurrent refreshes would break them). */
  private refreshing = new Map<string, Promise<Record<string, any>>>();

  constructor(
    private readonly db: DB,
    private readonly secrets: Secrets,
    private readonly config: Config,
  ) {}

  toPublic(row: AccountRow): PublicAccount {
    return {
      id: row.id,
      platform: row.platform,
      connector: row.connector,
      name: row.name,
      username: row.username,
      avatarUrl: row.avatar_url,
      status: row.status,
      statusMessage: row.status_message,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    };
  }

  info(row: AccountRow): AccountInfo {
    return {
      id: row.id,
      platform: row.platform,
      externalId: row.external_id,
      name: row.name,
      username: row.username,
      meta: JSON.parse(row.meta || "{}"),
    };
  }

  list(): PublicAccount[] {
    return this.db.listAccounts().map((r) => this.toPublic(r));
  }

  saveDrafts(connector: ConnectorId, drafts: AccountDraft[]): string[] {
    // Accounts from the same login (e.g. a LinkedIn profile and the Pages it manages) share one token.
    const grant = randomToken(9);
    return drafts.map((d) =>
      this.db.upsertAccount({
        platform: d.platform,
        connector,
        external_id: d.externalId,
        name: d.name,
        username: d.username ?? null,
        avatar_url: d.avatarUrl ?? null,
        credentials: this.secrets.encrypt(d.credentials),
        meta: JSON.stringify({ ...d.meta, grant }),
        expires_at: d.expiresAt ?? null,
      }),
    );
  }

  /** Decrypted credentials, refreshed first when the access token is (nearly) expired. */
  async credentials(accountId: string, opts: { force?: boolean } = {}): Promise<Record<string, any>> {
    const pending = this.refreshing.get(accountId);
    if (pending) return pending;

    const row = this.db.getAccount(accountId);
    if (!row) throw new AuthError("This account was disconnected.");
    const creds = this.secrets.decrypt<Record<string, any>>(row.credentials);
    const expiring = row.expires_at !== null && row.expires_at - Date.now() < REFRESH_MARGIN_MS;
    if (!expiring && !opts.force) return creds;

    const connector = getConnector(row.connector);
    if (!connector?.refresh) {
      if (row.expires_at !== null && row.expires_at < Date.now()) {
        const msg = `The ${connector?.name ?? row.platform} login expired. Reconnect the account.`;
        this.db.markAccountNeedsReauth(row.id, msg);
        throw new AuthError(msg);
      }
      return creds;
    }

    const job = (async () => {
      try {
        const refreshed = await connector.refresh!(this.config, this.info(row), creds);
        if (!refreshed) {
          if (row.expires_at !== null && row.expires_at < Date.now()) {
            throw new AuthError(`The ${connector.name} login expired. Reconnect the account.`);
          }
          return creds;
        }
        const grant = JSON.parse(row.meta || "{}").grant;
        for (const sibling of this.db.listAccounts()) {
          if (sibling.id === row.id || sibling.connector !== row.connector || !grant) continue;
          if (JSON.parse(sibling.meta || "{}").grant === grant) {
            this.db.updateAccountCredentials(sibling.id, this.secrets.encrypt(refreshed.credentials), refreshed.expiresAt);
          }
        }
        this.db.updateAccountCredentials(row.id, this.secrets.encrypt(refreshed.credentials), refreshed.expiresAt);
        return refreshed.credentials;
      } catch (err) {
        if (err instanceof AuthError) this.db.markAccountNeedsReauth(row.id, err.message);
        throw err;
      } finally {
        this.refreshing.delete(accountId);
      }
    })();
    this.refreshing.set(accountId, job);
    return job;
  }

  /**
   * Keeps long-lived tokens alive (Threads tokens die after 60 days unless refreshed) and flags expired
   * logins in the dashboard before a scheduled post hits them.
   */
  async maintain(): Promise<void> {
    const weekMs = 7 * 86400_000;
    for (const row of this.db.listAccounts()) {
      if (row.status !== "active" || row.expires_at === null) continue;
      const left = row.expires_at - Date.now();
      const connector = getConnector(row.connector);
      try {
        if (row.connector === "threads" || row.connector === "linkedin") {
          if (left < weekMs) await this.credentials(row.id, { force: true });
        } else if (left < 0 && !connector?.refresh) {
          this.db.markAccountNeedsReauth(row.id, `The ${connector?.name ?? row.platform} login expired. Reconnect the account.`);
        }
      } catch {
        // credentials() already flagged auth failures; transient errors are retried next run
      }
    }
  }
}
