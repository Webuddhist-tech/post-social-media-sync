import type { Config } from "../config.js";
import { ApiError, publishStep, request, UserError, type HttpResponse, type RequestOptions } from "../http.js";
import { readRange, type MediaFile } from "../media.js";
import { pollUntil } from "./common.js";
import type { AccountDraft, Connector, Platform, PublishContext } from "./types.js";

const REST = "https://api.linkedin.com/rest";

interface LinkedInCredentials {
  accessToken: string;
  refreshToken?: string | null;
  refreshExpiresAt?: number | null;
}

/** Version months to try: the configured one, else the last 12 months (newest first). */
export function candidateVersions(config: Config, now = new Date()): string[] {
  if (config.linkedin.version) return [config.linkedin.version];
  const out: string[] = [];
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  for (let i = 0; i < 12; i++) {
    out.push(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
    d.setUTCMonth(d.getUTCMonth() - 1);
  }
  return out;
}

let workingVersion: string | null = null;
export function resetLinkedInVersionCache() {
  workingVersion = null;
}

function isVersionError(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  const body = err.body as any;
  return err.status === 426 || /NONEXISTENT_VERSION|VERSION_MISSING|not active/i.test(`${body?.code ?? ""} ${body?.message ?? ""}`);
}

/**
 * Calls LinkedIn's versioned REST API. LinkedIn retires versions after ~1 year, so unless LINKEDIN_VERSION is
 * pinned we find the newest active version automatically and remember it.
 */
async function li<T = any>(config: Config, path: string, token: string, opts: RequestOptions = {}): Promise<HttpResponse<T>> {
  const versions = workingVersion ? [workingVersion] : candidateVersions(config);
  let lastErr: unknown;
  for (const version of versions) {
    try {
      const res = await request<T>(`${REST}/${path}`, {
        ...opts,
        headers: {
          Authorization: `Bearer ${token}`,
          "LinkedIn-Version": version,
          "X-Restli-Protocol-Version": "2.0.0",
          ...opts.headers,
        },
      });
      workingVersion = version;
      return res;
    } catch (err) {
      lastErr = err;
      if (!isVersionError(err)) throw err;
      if (workingVersion) {
        // The remembered version was retired while we were running; search again.
        workingVersion = null;
        return li(config, path, token, opts);
      }
    }
  }
  throw lastErr;
}

const RESERVED = /[\\|{}@[\]()<>#*_~]/g;
const escapeLittle = (s: string) => s.replace(RESERVED, (c) => "\\" + c);

/**
 * LinkedIn's `commentary` uses "little text" markup: reserved characters must be backslash-escaped or the post
 * gets cut off. Hashtags become hashtag templates so they stay clickable.
 */
export function toLittleText(text: string): string {
  const re = /(^|[^\p{L}\p{N}_&/])#([\p{L}\p{N}_]+)/gu;
  let out = "";
  let last = 0;
  for (const m of text.matchAll(re)) {
    const start = m.index! + m[1].length;
    out += escapeLittle(text.slice(last, start));
    out += `{hashtag|\\#|${escapeLittle(m[2])}}`;
    last = start + 1 + m[2].length;
  }
  return out + escapeLittle(text.slice(last));
}

/** Pages the member can post as: Administrator or Content Admin roles (each (Page, role) pair is its own row). */
async function postingOrgs(config: Config, token: string): Promise<Set<string>> {
  const orgs = new Set<string>();
  const count = 100;
  for (let start = 0; start < 2000; start += count) {
    const acls = await li(config, "organizationAcls", token, { query: { q: "roleAssignee", state: "APPROVED", start, count } });
    const elements: any[] = acls.data?.elements ?? [];
    for (const el of elements) {
      const urn: string | undefined = el.organization ?? el.organizationTarget;
      if (urn && ["ADMINISTRATOR", "CONTENT_ADMINISTRATOR"].includes(el.role)) orgs.add(urn);
    }
    const total = acls.data?.paging?.total;
    if (elements.length < count || (typeof total === "number" && start + count >= total)) break;
  }
  return orgs;
}

async function tokenRequest(form: Record<string, string>) {
  const res = await request("https://www.linkedin.com/oauth/v2/accessToken", { method: "POST", form });
  return res.data as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
    refresh_token_expires_in?: number;
    scope?: string;
  };
}

export const linkedinConnector: Connector = {
  id: "linkedin",
  name: "LinkedIn",
  platforms: ["linkedin"],
  kind: "oauth",
  developerPortal: "https://www.linkedin.com/developers/apps",
  isConfigured: (c) => !!(c.linkedin.clientId && c.linkedin.clientSecret),

  authorizeUrl(config, { state, redirectUri }) {
    const scopes = ["openid", "profile", "w_member_social"];
    if (config.linkedin.organizations) scopes.push("w_organization_social", "rw_organization_admin");
    const u = new URL("https://www.linkedin.com/oauth/v2/authorization");
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", config.linkedin.clientId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("state", state);
    u.searchParams.set("scope", scopes.join(" "));
    return u.toString();
  },

  async exchangeCode(config, { code, redirectUri }) {
    const t = await tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: config.linkedin.clientId,
      client_secret: config.linkedin.clientSecret,
    });
    const credentials: LinkedInCredentials = {
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? null,
      refreshExpiresAt: t.refresh_token_expires_in ? Date.now() + t.refresh_token_expires_in * 1000 : null,
    };
    const expiresAt = Date.now() + t.expires_in * 1000;
    const me = (
      await request("https://api.linkedin.com/v2/userinfo", { headers: { Authorization: `Bearer ${t.access_token}` } })
    ).data;

    const drafts: AccountDraft[] = [
      {
        platform: "linkedin",
        externalId: `urn:li:person:${me.sub}`,
        name: me.name || [me.given_name, me.family_name].filter(Boolean).join(" ") || "LinkedIn profile",
        avatarUrl: me.picture ?? null,
        credentials,
        meta: { kind: "person" },
        expiresAt,
      },
    ];

    if (config.linkedin.organizations) {
      const orgs = await postingOrgs(config, t.access_token);
      for (const urn of orgs) {
        const id = urn.split(":").pop()!;
        let name = `LinkedIn Page ${id}`;
        let username: string | null = null;
        try {
          const org = (await li(config, `organizations/${id}`, t.access_token)).data;
          name = org.localizedName ?? name;
          username = org.vanityName ?? null;
        } catch {
          // name lookup is cosmetic
        }
        drafts.push({ platform: "linkedin", externalId: urn, name, username, credentials, meta: { kind: "organization" }, expiresAt });
      }
    }
    return drafts;
  },

  async refresh(config, _account, credentials) {
    const c = credentials as LinkedInCredentials;
    // Only apps approved for programmatic refresh get refresh tokens; others must reconnect every 60 days.
    if (!c.refreshToken || (c.refreshExpiresAt && c.refreshExpiresAt < Date.now())) return null;
    const t = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: c.refreshToken,
      client_id: config.linkedin.clientId,
      client_secret: config.linkedin.clientSecret,
    });
    return {
      credentials: {
        accessToken: t.access_token,
        refreshToken: t.refresh_token ?? c.refreshToken,
        refreshExpiresAt: t.refresh_token_expires_in ? Date.now() + t.refresh_token_expires_in * 1000 : c.refreshExpiresAt,
      } satisfies LinkedInCredentials,
      expiresAt: Date.now() + t.expires_in * 1000,
    };
  },
};

const MAX_IMAGE_PIXELS = 36_152_320; // LinkedIn rejects images with this many pixels or more

async function uploadImage(ctx: PublishContext, token: string, owner: string, image: MediaFile): Promise<string> {
  // LinkedIn accepts JPEG, PNG and GIF below ~36 megapixels.
  const tooBig = (image.width ?? 0) * (image.height ?? 0) >= MAX_IMAGE_PIXELS && image.mime !== "image/gif";
  const supported = ["image/jpeg", "image/png", "image/gif"].includes(image.mime);
  const file = supported && !tooBig ? image : await ctx.media.jpegVariant(image, { maxDimension: 6000 });
  const init = await li(ctx.config, "images?action=initializeUpload", token, {
    method: "POST",
    json: { initializeUploadRequest: { owner } },
  });
  const { uploadUrl, image: urn } = init.data.value;
  await request(uploadUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
    body: await readRange(file.path, 0, file.size - 1),
    timeoutMs: 10 * 60_000,
  });
  return urn;
}

/** LinkedIn processes uploaded images asynchronously; posts should reference them once they're AVAILABLE. */
async function waitForImages(ctx: PublishContext, token: string, urns: string[]): Promise<void> {
  for (const urn of urns) {
    try {
      await pollUntil(
        ctx.sleep,
        async () => {
          const status = (await li(ctx.config, `images/${encodeURIComponent(urn)}`, token)).data?.status;
          if (status === "PROCESSING_FAILED") throw new Error("LinkedIn couldn't process one of the images.");
          return status === "AVAILABLE" ? true : null;
        },
        // Nothing is published yet, so a timeout here is safe to retry later.
        { intervalMs: 1500, maxIntervalMs: 10_000, timeoutMs: 5 * 60_000, what: "LinkedIn to process the images", retryableTimeout: true },
      );
    } catch (err) {
      // Member tokens (w_member_social) may not be allowed to read image status: give LinkedIn a moment instead.
      if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
        await ctx.sleep(5000);
        return;
      }
      throw err;
    }
  }
}

async function uploadVideo(ctx: PublishContext, token: string, owner: string, video: MediaFile): Promise<string> {
  const init = await li(ctx.config, "videos?action=initializeUpload", token, {
    method: "POST",
    json: { initializeUploadRequest: { owner, fileSizeBytes: video.size, uploadCaptions: false, uploadThumbnail: false } },
  });
  const { video: urn, uploadInstructions, uploadToken } = init.data.value;
  const etags: string[] = [];
  for (const [i, part] of (uploadInstructions as any[]).entries()) {
    ctx.progress(`Uploading video to LinkedIn (${i + 1}/${uploadInstructions.length})…`);
    const chunk = await readRange(video.path, part.firstByte, part.lastByte);
    const res = await request(part.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: chunk,
      timeoutMs: 30 * 60_000,
    });
    const etag = res.headers.get("etag");
    if (!etag) throw new ApiError("LinkedIn didn't return an ETag for an uploaded video part", res.status, null, true);
    etags.push(etag);
  }
  await li(ctx.config, "videos?action=finalizeUpload", token, {
    method: "POST",
    json: { finalizeUploadRequest: { video: urn, uploadToken: uploadToken ?? "", uploadedPartIds: etags } },
  });

  ctx.progress("Waiting for LinkedIn to process the video…");
  await pollUntil(
    ctx.sleep,
    async () => {
      const res = await li(ctx.config, `videos/${encodeURIComponent(urn)}`, token);
      const status = res.data?.status;
      if (status === "AVAILABLE") return true;
      if (status === "PROCESSING_FAILED") {
        throw new Error(`LinkedIn couldn't process the video: ${res.data?.processingFailureReason ?? "unknown reason"}`);
      }
      return null;
    },
    { intervalMs: 5000, timeoutMs: 30 * 60_000, what: "LinkedIn to process the video" },
  );
  return urn;
}

export const linkedin: Platform = {
  id: "linkedin",
  name: "LinkedIn",
  connector: "linkedin",
  capabilities: {
    textOnly: true,
    maxTextLength: 3000,
    maxImages: 20,
    video: true,
    mixedMedia: false,
    needsPublicMediaUrl: false,
    usesTitle: true,
  },
  options: [
    {
      key: "visibility",
      label: "Visibility",
      type: "select",
      choices: [
        { value: "PUBLIC", label: "Anyone" },
        { value: "CONNECTIONS", label: "Connections only (profiles only)" },
      ],
      default: "PUBLIC",
    },
  ],

  validate(input) {
    const errors: string[] = [];
    for (const m of input.media) {
      if (m.mime === "image/gif" && (m.width ?? 0) * (m.height ?? 0) >= MAX_IMAGE_PIXELS) {
        errors.push(`"${m.filename}" is too large for LinkedIn (GIFs must be under 36 megapixels).`);
      }
    }
    const video = input.media.find((m) => m.kind === "video");
    if (video) {
      if (!["video/mp4", "video/x-m4v"].includes(video.mime)) errors.push("LinkedIn only accepts MP4 videos.");
      if (video.size > 500 * 1024 * 1024) errors.push("LinkedIn videos must be under 500 MB.");
      if (video.duration && (video.duration < 3 || video.duration > 30 * 60)) {
        errors.push("LinkedIn videos must be between 3 seconds and 30 minutes long.");
      }
    }
    return errors;
  },

  async publish(ctx) {
    const { accessToken: token } = (await ctx.credentials()) as LinkedInCredentials;
    const author = ctx.account.externalId;
    const { media } = ctx.input;
    const isOrg = author.startsWith("urn:li:organization:");

    let content: Record<string, unknown> | undefined;
    if (media.length && media[0].kind === "video") {
      const urn = await uploadVideo(ctx, token, author, media[0]);
      content = { media: { id: urn, ...(ctx.input.title ? { title: ctx.input.title } : {}) } };
    } else if (media.length) {
      const urns: string[] = [];
      for (const [i, m] of media.entries()) {
        ctx.progress(`Uploading image ${i + 1} of ${media.length} to LinkedIn…`);
        urns.push(await uploadImage(ctx, token, author, m));
      }
      ctx.progress("Waiting for LinkedIn to process the images…");
      await waitForImages(ctx, token, urns);
      content = urns.length === 1 ? { media: { id: urns[0] } } : { multiImage: { images: urns.map((id) => ({ id })) } };
    }

    ctx.progress("Publishing on LinkedIn…");
    const visibility = isOrg ? "PUBLIC" : ctx.input.options.visibility === "CONNECTIONS" ? "CONNECTIONS" : "PUBLIC";
    const res = await publishStep("LinkedIn", () =>
      li(ctx.config, "posts", token, {
        method: "POST",
        json: {
          author,
          commentary: toLittleText(ctx.input.text),
          visibility,
          distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
          ...(content ? { content } : {}),
          lifecycleState: "PUBLISHED",
          isReshareDisabledByAuthor: false,
        },
      }),
    );
    const urn = res.headers.get("x-restli-id") ?? res.headers.get("x-linkedin-id");
    // Never fail after LinkedIn accepted the post: a retry would publish it twice.
    if (!urn) return { remoteId: "unknown", url: null, note: "Posted, but LinkedIn didn't return a link." };
    return { remoteId: urn, url: `https://www.linkedin.com/feed/update/${urn}/` };
  },

  async checkConnection(ctx) {
    const { accessToken: token } = (await ctx.credentials()) as LinkedInCredentials;
    const me = (await request("https://api.linkedin.com/v2/userinfo", { headers: { Authorization: `Bearer ${token}` } })).data;
    const who = me.name ?? "your LinkedIn profile";
    if (!ctx.account.externalId.startsWith("urn:li:organization:")) return `Can post as ${who}.`;
    const orgs = await postingOrgs(ctx.config, token);
    if (!orgs.has(ctx.account.externalId)) {
      throw new UserError(
        `${who} no longer has an Administrator or Content Admin role on the Page "${ctx.account.name}", so posts to it would be rejected.`,
      );
    }
    return `Logged in as ${who}; can post as the Page "${ctx.account.name}".`;
  },
};
