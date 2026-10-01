/** Small fetch wrapper with consistent error handling for all platform APIs. */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
    /** Whether retrying later has a reasonable chance of succeeding (rate limits, 5xx, network). */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Errors the user must fix themselves (bad input, missing setup). Never retried. */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}

/** The platform rejected our token: the account must be reconnected. */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  /** JSON body (sets Content-Type). */
  json?: unknown;
  /** application/x-www-form-urlencoded body. */
  form?: Record<string, string | number | boolean | undefined | null>;
  /** Raw body (Buffer, Blob, FormData, string). */
  body?: RequestInit["body"];
  /** Query string parameters appended to the URL. */
  query?: Record<string, string | number | boolean | undefined | null>;
  timeoutMs?: number;
  /** Statuses that should not throw (besides 2xx). */
  okStatuses?: number[];
}

export interface HttpResponse<T = any> {
  status: number;
  headers: Headers;
  data: T;
}

function withQuery(url: string, query?: RequestOptions["query"]): string {
  if (!query) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  }
  return u.toString();
}

function toForm(form: NonNullable<RequestOptions["form"]>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) {
    if (v !== undefined && v !== null) params.set(k, String(v));
  }
  return params;
}

/** Pulls a human-readable message out of the many error shapes platforms return. */
export function extractErrorMessage(body: unknown): string | null {
  if (!body) return null;
  if (typeof body === "string") return body.slice(0, 500) || null;
  if (typeof body !== "object") return String(body);
  const b = body as Record<string, any>;
  // Meta Graph: { error: { message, error_user_title, error_user_msg, code, error_subcode } }
  // Google:     { error: { message, errors: [...] } }
  // TikTok:     { error: { code, message, log_id } }
  if (b.error && typeof b.error === "object") {
    const e = b.error;
    const parts = [e.error_user_title, e.error_user_msg, e.message].filter((x) => typeof x === "string" && x);
    const msg = [...new Set(parts)].join(" — ");
    const code = e.code && e.code !== "ok" ? ` [${e.code}${e.error_subcode ? "/" + e.error_subcode : ""}]` : "";
    if (msg) return msg + code;
  }
  // OAuth: { error, error_description }   Bluesky XRPC: { error, message }
  if (typeof b.error === "string") {
    const detail = b.error_description ?? b.message;
    return typeof detail === "string" && detail ? `${b.error}: ${detail}` : b.error;
  }
  // X: { title, detail, errors: [{ message }] }
  if (typeof b.detail === "string") return b.title ? `${b.title}: ${b.detail}` : b.detail;
  if (Array.isArray(b.errors) && b.errors.length) {
    return b.errors.map((e: any) => e?.message ?? e?.detail ?? JSON.stringify(e)).join("; ");
  }
  // LinkedIn: { message, serviceErrorCode, status }
  if (typeof b.message === "string") return b.message;
  if (typeof b.error_message === "string") return b.error_message;
  return JSON.stringify(body).slice(0, 500);
}

export async function request<T = any>(url: string, opts: RequestOptions = {}): Promise<HttpResponse<T>> {
  const headers: Record<string, string> = { Accept: "application/json", ...opts.headers };
  let body: RequestInit["body"] = opts.body;
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    headers["Content-Type"] ??= "application/json";
  } else if (opts.form) {
    body = toForm(opts.form);
    headers["Content-Type"] ??= "application/x-www-form-urlencoded";
  }

  const target = withQuery(url, opts.query);
  let res: Response;
  try {
    res = await fetch(target, {
      method: opts.method ?? (body ? "POST" : "GET"),
      headers,
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
    });
  } catch (err) {
    const host = new URL(target).host;
    const reason = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
    throw new ApiError(`Network error talking to ${host}: ${reason}`, 0, null, true);
  }

  const text = await res.text();
  let data: any = text;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // keep raw text
    }
  } else {
    data = null;
  }

  if (!res.ok && !opts.okStatuses?.includes(res.status)) {
    const host = new URL(target).host;
    const detail = extractErrorMessage(data) ?? res.statusText;
    if (res.status === 401) throw new AuthError(`${host} rejected the access token (401): ${detail}`);
    const retryable = res.status === 429 || res.status >= 500;
    throw new ApiError(`${host} returned ${res.status}: ${detail}`, res.status, data, retryable);
  }
  return { status: res.status, headers: res.headers, data: data as T };
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
