import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { DashboardConfig } from "./config.js";

export const SESSION_COOKIE = "pss_session";
const SESSION_TTL_MS = 30 * 86400_000;
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

  constructor(private readonly config: DashboardConfig) {}

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
    const expires = now + SESSION_TTL_MS;
    return { ok: true, cookie: `${expires}.${this.sign(`session:${expires}`)}` };
  }

  hasSession(req: FastifyRequest): boolean {
    if (!this.config.dashboard) return false;
    const cookie = req.cookies?.[SESSION_COOKIE];
    if (!cookie) return false;
    const [expires, sig] = cookie.split(".");
    if (!expires || !sig || !(Number(expires) > Date.now())) return false;
    return safeEqual(sig, this.sign(`session:${expires}`));
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
