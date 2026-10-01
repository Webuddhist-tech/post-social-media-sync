import crypto from "node:crypto";

/** Encrypts platform credentials at rest (AES-256-GCM) and signs values (HMAC-SHA256). */
export class Secrets {
  private readonly encKey: Buffer;
  private readonly macKey: Buffer;

  constructor(appSecret: string) {
    this.encKey = Buffer.from(crypto.hkdfSync("sha256", appSecret, "post-social-media-sync", "encryption", 32));
    this.macKey = Buffer.from(crypto.hkdfSync("sha256", appSecret, "post-social-media-sync", "signing", 32));
  }

  encrypt(value: unknown): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.encKey, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return "v1:" + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
  }

  decrypt<T = unknown>(payload: string): T {
    if (!payload.startsWith("v1:")) throw new Error("Unsupported credential format");
    const raw = Buffer.from(payload.slice(3), "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.encKey, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const plaintext = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8")) as T;
  }

  sign(value: string): string {
    return crypto.createHmac("sha256", this.macKey).update(value).digest("base64url");
  }

  verify(value: string, signature: string): boolean {
    return safeEqual(this.sign(value), signature);
  }
}

export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

/** PKCE (RFC 7636) S256 code challenge. */
export function pkceChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}
