import type { Config } from "../config.js";
import type { MediaFile, MediaStore } from "../media.js";

import type { Capabilities, ConnectorId, CredentialField, OptionField, PlatformId } from "../types.js";

export type { Capabilities, ConnectorId, CredentialField, OptionField, PlatformId };

/** Everything a platform needs to publish one post to one account. */
export interface PublishInput {
  text: string;
  title: string | null;
  media: MediaFile[];
  options: Record<string, unknown>;
}

export interface AccountInfo {
  id: string;
  ownerId: string;
  platform: PlatformId;
  externalId: string;
  name: string;
  username: string | null;
  meta: Record<string, any>;
}

export interface PublishContext<C = any> {
  account: AccountInfo;
  input: PublishInput;
  config: Config;
  media: MediaStore;
  /** Current credentials, refreshed first if they're about to expire (or always, with `force`). */
  credentials(opts?: { force?: boolean }): Promise<C>;
  /** Reports progress shown live in the dashboard. */
  progress(message: string): void;
  /** Waits (overridable in tests). */
  sleep(ms: number): Promise<void>;
}

export interface PublishResult {
  remoteId: string;
  url: string | null;
  /** Extra info shown to the user, e.g. "Uploaded as private because the app isn't audited". */
  note?: string | null;
}

/** What a connection check gets: the account and its (refreshed) credentials. */
export interface CheckContext<C = any> {
  account: AccountInfo;
  config: Config;
  credentials(opts?: { force?: boolean }): Promise<C>;
}

export interface Platform {
  id: PlatformId;
  name: string;
  connector: ConnectorId;
  capabilities: Capabilities;
  options: OptionField[];
  /** Platform-specific validation beyond the generic capability checks. Returns error messages. */
  validate?(input: PublishInput, config: Config): string[];
  publish(ctx: PublishContext): Promise<PublishResult>;
  /**
   * Checks that the saved login still works, without posting anything. Returns a short description of what the
   * account can do (e.g. "Can post as @name"). Throws AuthError if the login is no longer valid.
   */
  checkConnection(ctx: CheckContext): Promise<string>;
}

/** A connected account as produced by a connector after login. */
export interface AccountDraft {
  platform: PlatformId;
  externalId: string;
  name: string;
  username?: string | null;
  avatarUrl?: string | null;
  credentials: Record<string, any>;
  meta?: Record<string, any>;
  /** When the access token expires (ms epoch), if it does. */
  expiresAt?: number | null;
}

export interface RefreshResult {
  credentials: Record<string, any>;
  expiresAt: number | null;
}

/** Handles login for one or more platforms (e.g. Meta login yields Facebook Pages and Instagram accounts). */
export interface Connector {
  id: ConnectorId;
  name: string;
  platforms: PlatformId[];
  kind: "oauth" | "credentials";
  /** Where to create the developer app. */
  developerPortal?: string;
  isConfigured(config: Config): boolean;

  // OAuth connectors
  usesPkce?: boolean;
  authorizeUrl?(config: Config, args: { state: string; redirectUri: string; codeChallenge: string | null }): string;
  exchangeCode?(
    config: Config,
    args: { code: string; redirectUri: string; codeVerifier: string | null; query: Record<string, string> },
  ): Promise<AccountDraft[]>;

  // Credential connectors (e.g. Bluesky app passwords)
  credentialFields?: CredentialField[];
  connectWithCredentials?(config: Config, fields: Record<string, string>): Promise<AccountDraft[]>;

  /** Refreshes credentials. Return null if this account's token can't/needn't be refreshed. */
  refresh?(config: Config, account: AccountInfo, credentials: Record<string, any>): Promise<RefreshResult | null>;
}
