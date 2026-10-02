import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { DashboardConfig } from "./config.js";

export const SESSION_COOKIE = "pss_session";
const SESSION_TTL_MS = 30 * 86400_000;
/** In DATA_DIR: sessions issued at or before this time (ms) were logged out. */
const NOT_BEFORE_FILE = ".sessions-not-before";
/** How long a replica trusts its copy of that file before re-reading it (another replica may have logged out). */
const NOT_BEFORE_CACHE_MS = 5000;
/** Owner id of everything created through the password-protected dashboard. */
export const DASHBOARD_OWNER = "default";
const OWNER_ID = /^[A-Za-z0-9._:@|-]{1,200}$/;

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Who is calling:
 * - the dashboard (password → signed session cookie) acts as the single owner "default";
 * - backends send `Authorization: Bearer <API_TOKEN>` and may act for any of their users with `X-Owner-Id`.
 */
export class Auth {
  private failures = new Map<string, { count: number; until: number }>();
  private notBefore = { value: 0, readAt: -Infinity };
  private readonly notBeforeFile: string;

  constructor(private readonly config: DashboardConfig) {
    this.notBeforeFile = path.join(config.dataDir, NOT_BEFORE_FILE);
  }

  /** Session cookies are stateless, so logging out moves this cut-off instead of deleting anything. */
  private sessionsNotBefore(): number {
    const now = Date.now();
    if (now - this.notBefore.readAt >= NOT_BEFORE_CACHE_MS) {
      let stored = 0;
      try {
        stored = Number(fs.readFileSync(this.notBeforeFile, "utf8").trim()) || 0;
      } catch (err: any) {
        if (err?.code !== "ENOENT") throw err;
      }
      // Logouts only ever move it forward.
      this.notBefore = { value: Math.max(this.notBefore.value, stored), readAt: now };
    }
    return this.notBefore.value;
  }

  /** Ends every dashboard session: all browsers, and all replicas sharing DATA_DIR (within a few seconds). */
  logoutEverywhere(): void {
    const now = Date.now();
    const value = Math.max(now, this.sessionsNotBefore());
    this.notBefore = { value, readAt: now };
    const tmp = `${this.notBeforeFile}.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
    fs.writeFileSync(tmp, `${value}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.notBeforeFile);
  }

  private sign(value: string): string {
    return crypto.createHmac("sha256", this.config.secret).update(value).digest("base64url");
  }

  /** Returns a cookie value on success, or null. Slows down brute force per IP. */
  login(password: string, ip: string): { ok: true; cookie: string } | { ok: false; retryAfterSec?: number } {
    const now = Date.now();
    for (const [key, f] of this.failures) if (f.until <= now) this.failures.delete(key);
    const f = this.failures.get(ip);
    if (f && f.count >= 5 && f.until > now) return { ok: false, retryAfterSec: Math.ceil((f.until - now) / 1000) };

    if (!this.config.adminPassword || !safeEqual(password, this.config.adminPassword)) {
      this.failures.set(ip, { count: (f?.count ?? 0) + 1, until: now + 15 * 60_000 });
      return { ok: false };
    }
    this.failures.delete(ip);
    // Issued strictly after the last logout, even within the same millisecond.
    const expires = Math.max(now, this.sessionsNotBefore() + 1) + SESSION_TTL_MS;
    return { ok: true, cookie: `${expires}.${this.sign(`session:${expires}`)}` };
  }

  hasSession(req: FastifyRequest): boolean {
    if (!this.config.dashboard) return false;
    const cookie = req.cookies?.[SESSION_COOKIE];
    if (!cookie) return false;
    const [expires, sig] = cookie.split(".");
    if (!expires || !sig || !(Number(expires) > Date.now())) return false;
    if (!safeEqual(sig, this.sign(`session:${expires}`))) return false;
    return Number(expires) - SESSION_TTL_MS > this.sessionsNotBefore();
  }

  /** The owner this request acts for, or null if it isn't authenticated. Throws for a malformed X-Owner-Id. */
  ownerId(req: FastifyRequest): string | null {
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) {
      if (!this.config.apiToken || !safeEqual(header.slice(7).trim(), this.config.apiToken)) return null;
      const owner = req.headers["x-owner-id"];
      if (owner === undefined) return DASHBOARD_OWNER;
      if (typeof owner !== "string" || !OWNER_ID.test(owner)) {
        throw Object.assign(new Error("X-Owner-Id must be 1-200 characters: letters, digits and . _ : @ | -"), { statusCode: 400 });
      }
      return owner;
    }
    return this.hasSession(req) ? DASHBOARD_OWNER : null;
  }

  setCookie(reply: FastifyReply, value: string): void {
    reply.setCookie(SESSION_COOKIE, value, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: this.config.siteUrl.startsWith("https://"),
      maxAge: SESSION_TTL_MS / 1000,
    });
  }

  clearCookie(reply: FastifyReply): void {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
  }
}
