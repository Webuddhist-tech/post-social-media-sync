import type { Config } from "./config.js";
import { randomToken, type Secrets } from "./crypto.js";
import type { PostSyncEmitter } from "./events.js";
import { ApiError, AuthError, RefreshError } from "./http.js";
import { getConnector } from "./platforms/index.js";
import type { AccountDraft, AccountInfo, ConnectorId } from "./platforms/types.js";
import type { AccountRow, Storage } from "./storage/types.js";
import type { PublicAccount } from "./types.js";

/** Refresh access tokens this long before they expire. */
const REFRESH_MARGIN_MS = 5 * 60_000;

export class AccountService {
  /** Serializes refreshes per account (X refresh tokens are single-use, so concurrent refreshes would break them). */
  private refreshing = new Map<string, Promise<Record<string, any>>>();

  constructor(
    private readonly db: Storage,
    private readonly secrets: Secrets,
    private readonly config: Config,
    private readonly events: PostSyncEmitter,
  ) {}

  toPublic(row: AccountRow): PublicAccount {
    return {
      id: row.id,
      ownerId: row.owner_id,
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
      ownerId: row.owner_id,
      platform: row.platform,
      externalId: row.external_id,
      name: row.name,
      username: row.username,
      meta: JSON.parse(row.meta || "{}"),
    };
  }

  async list(ownerId: string): Promise<PublicAccount[]> {
    return (await this.db.listAccounts(ownerId)).map((r) => this.toPublic(r));
  }

  async saveDrafts(ownerId: string, connector: ConnectorId, drafts: AccountDraft[]): Promise<PublicAccount[]> {
    // Accounts from the same login (e.g. a LinkedIn profile and the Pages it manages) share one token.
    const grant = randomToken(9);
    const saved: PublicAccount[] = [];
    for (const d of drafts) {
      const id = await this.db.upsertAccount({
        owner_id: ownerId,
        platform: d.platform,
        connector,
        external_id: d.externalId,
        name: d.name,
        username: d.username ?? null,
        avatar_url: d.avatarUrl ?? null,
        credentials: this.secrets.encrypt(d.credentials),
        meta: JSON.stringify(d.meta ?? {}),
        grant_id: grant,
        expires_at: d.expiresAt ?? null,
      });
      const row = await this.db.getAccount(ownerId, id);
      if (row) saved.push(this.toPublic(row));
    }
    if (saved.length) this.events.emit("account.connected", { accounts: saved });
    return saved;
  }

  async remove(ownerId: string, id: string): Promise<boolean> {
    const row = await this.db.getAccount(ownerId, id);
    if (!row || !(await this.db.deleteAccount(ownerId, id))) return false;
    this.events.emit("account.disconnected", { account: this.toPublic(row) });
    return true;
  }

  async markNeedsReconnect(row: AccountRow, message: string): Promise<void> {
    await this.db.setAccountStatus(row.id, "needs_reauth", message);
    this.events.emit("account.needsReconnect", {
      account: { ...this.toPublic(row), status: "needs_reauth", statusMessage: message },
      message,
    });
  }

  async markActive(row: AccountRow): Promise<void> {
    if (row.status !== "active") await this.db.setAccountStatus(row.id, "active", null);
  }

  /** Decrypted credentials, refreshed first when the access token is (nearly) expired. */
  async credentials(accountId: string, opts: { force?: boolean } = {}): Promise<Record<string, any>> {
    const pending = this.refreshing.get(accountId);
    if (pending) return pending;

    const row = await this.db.getAccount(null, accountId);
    if (!row) throw new AuthError("This account was disconnected.");
    const creds = this.secrets.decrypt<Record<string, any>>(row.credentials);
    const expiring = row.expires_at !== null && row.expires_at - Date.now() < REFRESH_MARGIN_MS;
    if (!expiring && !opts.force) return creds;

    const connector = getConnector(row.connector);
    if (!connector?.refresh) {
      if (row.expires_at !== null && row.expires_at < Date.now()) {
        const msg = `The ${connector?.name ?? row.platform} login expired. Reconnect the account.`;
        await this.markNeedsReconnect(row, msg);
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
        const encrypted = this.secrets.encrypt(refreshed.credentials);
        const siblings = row.grant_id ? await this.db.accountsByGrant(row.owner_id, row.connector, row.grant_id) : [row];
        for (const account of siblings.some((s) => s.id === row.id) ? siblings : [...siblings, row]) {
          await this.db.updateAccountCredentials(account.id, encrypted, refreshed.expiresAt);
        }
        return refreshed.credentials;
      } catch (err) {
        if (err instanceof AuthError) await this.markNeedsReconnect(row, err.message);
        // A refresh hiccup must never look like a failed publish request (see publishStep).
        if (err instanceof ApiError && !(err instanceof RefreshError)) throw new RefreshError(err);
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
   * logins before a scheduled post hits them.
   */
  async maintain(): Promise<void> {
    const weekMs = 7 * 86400_000;
    for (const row of await this.db.accountsExpiringBefore(Date.now() + weekMs)) {
      const connector = getConnector(row.connector);
      try {
        if (row.connector === "threads" || row.connector === "linkedin") {
          await this.credentials(row.id, { force: true });
        } else if (row.expires_at! < Date.now() && !connector?.refresh) {
          await this.markNeedsReconnect(row, `The ${connector?.name ?? row.platform} login expired. Reconnect the account.`);
        }
      } catch {
        // credentials() already flagged auth failures; transient errors are retried next run
      }
    }
  }
}
