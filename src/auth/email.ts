import { randomInt } from "node:crypto";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function canonicalEmail(email: string | null | undefined): string | null {
  if (typeof email !== "string") return null;
  const normalized = email.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function parseEmail(value: unknown): string | null {
  const email = canonicalEmail(typeof value === "string" ? value : null);
  if (!email || email.length > 254) return null;
  if (!EMAIL_PATTERN.test(email)) return null;
  return email;
}

export function newEmailCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function parseEmailCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim();
  if (!/^\d{6}$/.test(code)) return null;
  return code;
}

export const OTP_MAX_FAILURES = 5;
export const OTP_FAILURE_WINDOW_MS = 15 * 60_000;
export const OTP_LOCKOUT_MS = 15 * 60_000;

type GuardEntry = { failures: number; windowStart: number; lockedUntil: number };

/**
 * Per-mailbox brute-force guard for the 6-digit email code. After
 * `maxFailures` wrong guesses in `failureWindowMs`, verification for that mailbox is
 * locked for `lockoutMs` — even a correct code is refused while locked, so a
 * million-guess search is not feasible. In-process state (resets on restart).
 */
export class EmailCodeGuard {
  private readonly entries = new Map<string, GuardEntry>();
  private readonly maxFailures: number;
  private readonly failureWindowMs: number;
  private readonly lockoutMs: number;

  constructor(
    options: { maxFailures?: number; failureWindowMs?: number; lockoutMs?: number } = {},
  ) {
    this.maxFailures = options.maxFailures ?? OTP_MAX_FAILURES;
    this.failureWindowMs = options.failureWindowMs ?? OTP_FAILURE_WINDOW_MS;
    this.lockoutMs = options.lockoutMs ?? OTP_LOCKOUT_MS;
  }

  /** Seconds remaining on an active lockout, or 0 when verification is allowed. */
  lockedForSeconds(email: string, nowMs: number): number {
    const entry = this.entries.get(email);
    if (!entry || nowMs >= entry.lockedUntil) return 0;
    return Math.max(1, Math.ceil((entry.lockedUntil - nowMs) / 1000));
  }

  /** Record a wrong code; returns true when this failure triggered a lockout. */
  recordFailure(email: string, nowMs: number): boolean {
    this.prune(nowMs);
    let entry = this.entries.get(email);
    if (!entry || nowMs - entry.windowStart >= this.failureWindowMs) {
      entry = { failures: 0, windowStart: nowMs, lockedUntil: 0 };
      this.entries.set(email, entry);
    }
    entry.failures += 1;
    if (entry.failures >= this.maxFailures) {
      entry.lockedUntil = nowMs + this.lockoutMs;
      entry.failures = 0;
      entry.windowStart = nowMs;
      return true;
    }
    return false;
  }

  recordSuccess(email: string): void {
    this.entries.delete(email);
  }

  private prune(nowMs: number): void {
    if (this.entries.size < 10_000) return;
    for (const [email, entry] of this.entries) {
      if (nowMs >= entry.lockedUntil && nowMs - entry.windowStart >= this.failureWindowMs) {
        this.entries.delete(email);
      }
    }
  }
}
