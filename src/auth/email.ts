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
