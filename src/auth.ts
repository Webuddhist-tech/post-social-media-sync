import type { FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import { safeEqual, type Secrets } from "./crypto.js";

export const SESSION_COOKIE = "pss_session";
const SESSION_TTL_MS = 30 * 86400_000;

/** Single-user dashboard login: password → signed session cookie. API clients can use a bearer token instead. */
export class Auth {
  private failures = new Map<string, { count: number; until: number }>();

  constructor(
    private readonly config: Config,
    private readonly secrets: Secrets,
  ) {}

  /** Returns a cookie value on success, or null. Slows down brute force per IP. */
  login(password: string, ip: string): { ok: true; cookie: string } | { ok: false; retryAfterSec?: number } {
    const now = Date.now();
    const f = this.failures.get(ip);
    if (f && f.count >= 5 && f.until > now) return { ok: false, retryAfterSec: Math.ceil((f.until - now) / 1000) };

    if (!safeEqual(password, this.config.adminPassword)) {
      const count = f && f.until > now ? f.count + 1 : 1;
      this.failures.set(ip, { count, until: now + 15 * 60_000 });
      return { ok: false };
    }
    this.failures.delete(ip);
    const expires = now + SESSION_TTL_MS;
    return { ok: true, cookie: `${expires}.${this.secrets.sign(`session:${expires}`)}` };
  }

  isAuthenticated(req: FastifyRequest): boolean {
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ") && this.config.apiToken) {
      return safeEqual(header.slice(7).trim(), this.config.apiToken);
    }
    const cookie = req.cookies?.[SESSION_COOKIE];
    if (!cookie) return false;
    const [expires, sig] = cookie.split(".");
    if (!expires || !sig || Number(expires) < Date.now()) return false;
    return this.secrets.verify(`session:${expires}`, sig);
  }

  setCookie(reply: FastifyReply, value: string): void {
    reply.setCookie(SESSION_COOKIE, value, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: this.config.publicBaseUrl.startsWith("https://"),
      maxAge: SESSION_TTL_MS / 1000,
    });
  }

  clearCookie(reply: FastifyReply): void {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
  }
}
