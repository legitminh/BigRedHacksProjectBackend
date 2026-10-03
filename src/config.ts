import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type Config = {
  port: number;
  publicBaseUrl: string;
  googleClientId: string | null;
  googleClientSecret: string | null;
  sessionSecret: string | null;
  databaseUrl: string | null;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  corsOrigins: string[];
  redirectUri: string;
  calendarRedirectUri: string;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpUser: string | null;
  smtpPass: string | null;
  mailFrom: string | null;
  geminiApiKey: string | null;
  geminiModel: string;
};

const PENDING_TTL_SECONDS = 600;
const EMAIL_CODE_TTL_SECONDS = 600;

export function pendingTtlSeconds(): number {
  return PENDING_TTL_SECONDS;
}

export function emailCodeTtlSeconds(): number {
  return EMAIL_CODE_TTL_SECONDS;
}

export function loadEnvFile(path = resolve(".env")): void {
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function nonempty(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function optionalPort(value: string | undefined): number | null {
  if (!value || !value.trim()) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = positiveInt(env.PORT, 8787);
  const publicBaseUrl = (nonempty(env.PUBLIC_BASE_URL) ?? `http://127.0.0.1:${port}`).replace(
    /\/+$/,
    "",
  );
  const sessionSecret = nonempty(env.SESSION_SECRET);
  return {
    port,
    publicBaseUrl,
    googleClientId: nonempty(env.GOOGLE_CLIENT_ID),
    googleClientSecret: nonempty(env.GOOGLE_CLIENT_SECRET),
    sessionSecret: sessionSecret && sessionSecret.length >= 32 ? sessionSecret : null,
    databaseUrl: nonempty(env.DATABASE_URL),
    accessTokenTtlSeconds: positiveInt(env.ACCESS_TOKEN_TTL_SECONDS, 900),
    refreshTokenTtlSeconds: positiveInt(env.REFRESH_TOKEN_TTL_SECONDS, 2_592_000),
    corsOrigins: (env.WAYPOINT_CORS_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    redirectUri: `${publicBaseUrl}/v1/auth/google/callback`,
    calendarRedirectUri: `${publicBaseUrl}/v1/google/calendar/callback`,
    smtpHost: nonempty(env.SMTP_HOST),
    smtpPort: optionalPort(env.SMTP_PORT),
    smtpUser: nonempty(env.SMTP_USER),
    smtpPass: nonempty(env.SMTP_PASS),
    mailFrom: nonempty(env.MAIL_FROM),
    geminiApiKey: nonempty(env.GEMINI_API_KEY),
    geminiModel: nonempty(env.GEMINI_MODEL) ?? "gemini-flash-latest",
  };
}

export function googleConfigured(config: Config): boolean {
  return config.googleClientId !== null && config.googleClientSecret !== null;
}
