import crypto from "node:crypto";
import type { PostSync, PostSyncEventName } from "post-social-media-sync";

export interface WebhookOptions {
  url: string;
  /** Signs each delivery: `X-Post-Sync-Signature: sha256=HMAC(secret, "<timestamp>.<body>")`. */
  secret: string | null;
  /** Events to send (default: all except the chatty target.progress). */
  events: PostSyncEventName[] | null;
  log: { warn(msg: string): void };
  /** Waits between retries (tests). */
  sleep?: (ms: number) => Promise<void>;
}

/** Signature for a webhook body, as sent in X-Post-Sync-Signature. Receivers recompute and compare it. */
export function signWebhook(secret: string, timestamp: string, body: string): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/** POSTs engine events (post published, failed, account needs reconnecting, …) to a URL, for non-Node backends. */
export function forwardEvents(sync: PostSync, opts: WebhookOptions): () => void {
  const wanted = opts.events ? new Set<string>(opts.events) : null;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  async function deliver(event: string, data: unknown): Promise<void> {
    const id = crypto.randomUUID();
    const body = JSON.stringify({ id, event, data, createdAt: Date.now() });
    for (let attempt = 1; attempt <= 4; attempt++) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "user-agent": "post-sync-webhooks",
        "x-post-sync-event": event,
        "x-post-sync-delivery": id,
        "x-post-sync-timestamp": timestamp,
      };
      if (opts.secret) headers["x-post-sync-signature"] = signWebhook(opts.secret, timestamp, body);
      let status = 0;
      try {
        const res = await fetch(opts.url, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000), redirect: "manual" });
        status = res.status;
        await res.body?.cancel().catch(() => {});
        if (res.ok) return;
      } catch {
        // network error: retry
      }
      // A 4xx other than timeout/rate limit won't get better by retrying.
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) break;
      if (attempt < 4) await sleep(1000 * 4 ** (attempt - 1));
    }
    opts.log.warn(`webhook delivery of ${event} to ${new URL(opts.url).host} failed`);
  }

  return sync.events.onAny((event, data) => {
    if (wanted ? !wanted.has(event) : event === "target.progress") return;
    void deliver(event, data);
  });
}
