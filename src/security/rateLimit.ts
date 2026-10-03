import type { IncomingMessage } from "node:http";

import { HttpError } from "../http.ts";

/** Fixed-window rule: at most `limit` hits per `windowMs` per key. */
export type RateRule = { limit: number; windowMs: number };

const MIN = 60_000;

/**
 * Default abuse shields. Tuned so normal desktop use never trips them, while a
 * script hammering email/OTP/TTS/LLM endpoints is cut off quickly.
 * Override per-bucket via `AppDeps.rateRules` (tests, ops).
 */
export const DEFAULT_RATE_RULES = {
  /** Email login code requests per client IP. */
  emailStartIp: { limit: 10, windowMs: 15 * MIN },
  /** Email login code requests per target mailbox (stops inbox bombing). */
  emailStartEmail: { limit: 5, windowMs: 15 * MIN },
  /** Email code verification attempts per client IP (on top of per-email OTP lockout). */
  emailVerifyIp: { limit: 30, windowMs: 15 * MIN },
  /** Google sign-in starts per IP. */
  googleStartIp: { limit: 20, windowMs: 10 * MIN },
  /** Refresh-token exchanges per IP. */
  refreshIp: { limit: 60, windowMs: 10 * MIN },
  /** Anonymous/any status polling per IP (cheap, but unauthenticated). */
  statusIp: { limit: 60, windowMs: MIN },
  /** Gemini ephemeral token mints per user. */
  ephemeralUser: { limit: 20, windowMs: MIN },
  /** Pre-auth guard on /v1/coach/* per IP (blunts COACH_API_TOKEN guessing). */
  coachIp: { limit: 120, windowMs: MIN },
  /** Authenticated lock-in coach (Ollama) per identity. */
  coachUser: { limit: 60, windowMs: MIN },
  /** Pre-auth guard on /v1/voice/tts per IP. */
  ttsIp: { limit: 60, windowMs: MIN },
  /** Authenticated xAI TTS per identity (each hit costs money). */
  ttsUser: { limit: 30, windowMs: MIN },
  /** Gemini/companion chat per IP. */
  chatIp: { limit: 60, windowMs: MIN },
} as const satisfies Record<string, RateRule>;

export type RateRules = { [K in keyof typeof DEFAULT_RATE_RULES]: RateRule };

export type RateResult = { ok: true } | { ok: false; retryAfterSeconds: number };

type Entry = { count: number; resetAt: number };

/**
 * Small in-process fixed-window limiter. State is per-process (a restart or a
 * second instance resets it) — good enough for the single-node deployment and
 * as a seatbelt behind a reverse proxy's own limits.
 */
export class RateLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly maxKeys: number;

  constructor(options: { maxKeys?: number } = {}) {
    this.maxKeys = options.maxKeys ?? 20_000;
  }

  /** Record a hit; returns whether the caller is still within `rule`. */
  hit(bucket: string, id: string, rule: RateRule, nowMs: number): RateResult {
    const key = `${bucket}\u0000${id}`;
    const existing = this.entries.get(key);
    if (!existing || nowMs >= existing.resetAt) {
      this.prune(nowMs);
      this.entries.set(key, { count: 1, resetAt: nowMs + rule.windowMs });
      return { ok: true };
    }
    if (existing.count >= rule.limit) {
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - nowMs) / 1000)) };
    }
    existing.count += 1;
    return { ok: true };
  }

  /** Like `hit`, but throws a 429 `HttpError` (with Retry-After) when over limit. */
  consume(bucket: string, id: string, rule: RateRule, nowMs: number): void {
    const result = this.hit(bucket, id, rule, nowMs);
    if (!result.ok) throw rateLimited(result.retryAfterSeconds);
  }

  get size(): number {
    return this.entries.size;
  }

  private prune(nowMs: number): void {
    if (this.entries.size < this.maxKeys) return;
    for (const [key, entry] of this.entries) {
      if (nowMs >= entry.resetAt) this.entries.delete(key);
    }
    // Still full of live keys (flood from many IPs): drop oldest-inserted entries.
    let excess = this.entries.size - this.maxKeys + 1;
    if (excess <= 0) return;
    for (const key of this.entries.keys()) {
      this.entries.delete(key);
      if (--excess <= 0) break;
    }
  }
}

export function rateLimited(retryAfterSeconds: number, code = "rate_limited"): HttpError {
  const error = new HttpError(429, code, "Too many requests. Please slow down and try again shortly.");
  error.retryAfterSeconds = retryAfterSeconds;
  return error;
}

/**
 * Client address for rate-limit keys. Only trusts X-Forwarded-For when the
 * operator opted in (`TRUST_PROXY=1`) — otherwise a client could spoof it to
 * dodge limits. With a single trusted proxy the rightmost entry is the one the
 * proxy itself appended.
 */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    const raw = Array.isArray(forwarded) ? forwarded.join(",") : forwarded;
    if (raw) {
      const parts = raw
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      const last = parts[parts.length - 1];
      if (last) return last;
    }
  }
  return req.socket.remoteAddress ?? "unknown";
}
