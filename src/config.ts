import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type Config = {
  port: number;
  /** Interface to bind. Use 127.0.0.1 for local-only; 0.0.0.0 behind a reverse proxy on the website host. */
  bindHost: string;
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
  /** Short Copilot / voice REST turns (Flash-Lite — high free RPD). */
  geminiModel: string;
  /**
   * Deeper REST model when DEEP BRIEF / FULL CONTENTS or list-style asks need every row.
   * Flash-Lite collapses inventories into category blurbs; default gemini-3.5-flash (free tier).
   * gemini-3.8-flash is an alternative if your key exposes it.
   */
  geminiOverviewModel: string;
  /** Gemini Live model for study companion WebSocket proxy (`/v1/companion/live`). */
  geminiLiveModel: string;
  /**
   * xAI / Grok API key for study heads-up TTS (`POST /v1/voice/tts`) and the
   * final-review concept map (`POST /v1/concept-map` → Grok Imagine).
   * Stays on this server only — never bake into Waypoint.app.
   */
  xaiApiKey: string | null;
  /** Built-in xAI voice id (eve, ara, …). Defaults to eve. */
  xaiTtsVoice: string;
  /**
   * Presage Technologies API key for camera accountability vitals (`POST /v1/camera/observe`).
   * Stays on this server only — never bake into Waypoint.app.
   */
  presageApiKey: string | null;
  /**
   * Which engine serves Copilot chat when local inference is preferred.
   * - `ollama`: always use Ollama (`OLLAMA_CHAT_MODEL`); never call Gemini for chat.
   * - `gemini`: Gemini first; silent Ollama fallback on quota/outage (cloud companion path).
   * Set via LOCAL_CHAT_PROVIDER (`ollama`|`llama`|`local`|`gemini`|`cloud`).
   */
  localChatProvider: "ollama" | "gemini";
  /** Ollama base on the API host (not the end-user machine), e.g. http://127.0.0.1:11434 */
  ollamaBaseUrl: string | null;
  /** Shared secret the desktop app sends as Bearer for /v1/coach/* (optional if using user JWT). */
  coachApiToken: string | null;
  /** Tiny lock-in coach model (fast, on-device via API proxy). */
  ollamaModel: string;
  ollamaVisionModel: string;
  /**
   * Stronger quantized chat model for local Copilot (and Gemini fallback).
   * Runs on the API host via Ollama (not the end-user Mac).
   */
  ollamaChatModel: string;
  /** Context window for Copilot local path (calendar/Drive-heavy prompts). */
  ollamaChatNumCtx: number;
  /** Shared secret for the local HTML admin console at /admin. */
  adminPassword: string | null;
  /** NODE_ENV=production — hardens defaults (e.g. email auth requires real SMTP). */
  production: boolean;
  /**
   * Trust X-Forwarded-For (rightmost hop) for per-IP rate limits. Enable ONLY behind
   * a reverse proxy you control; otherwise clients could spoof their address.
   */
  trustProxy: boolean;
  /** Extra Ollama models /v1/coach/api/generate may use (on top of the three configured above). */
  ollamaAllowedModels: string[];
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
    // Treat blank process.env values as unset so .env can fill them
    // (shells/CI often export DATABASE_URL=).
    const existing = process.env[key];
    if (existing === undefined || existing.trim() === "") {
      process.env[key] = value;
    }
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

/** Parse a boolean env flag. Only 1/true/yes/on enable; anything else is off. */
export function parseEnvFlag(value: string | undefined): boolean {
  const raw = (value ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/** Parse LOCAL_CHAT_PROVIDER — aliases map onto ollama vs gemini. */
export function parseLocalChatProvider(
  value: string | undefined,
): "ollama" | "gemini" {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) return "gemini";
  if (raw === "ollama" || raw === "llama" || raw === "local" || raw === "on-device") {
    return "ollama";
  }
  if (raw === "gemini" || raw === "cloud" || raw === "google") {
    return "gemini";
  }
  // Unknown values fall back to cloud companion path (safer than forcing local).
  return "gemini";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = positiveInt(env.PORT, 8787);
  const publicBaseUrl = (nonempty(env.PUBLIC_BASE_URL) ?? `http://127.0.0.1:${port}`).replace(
    /\/+$/,
    "",
  );
  const sessionSecret = nonempty(env.SESSION_SECRET);
  const bindHost = nonempty(env.BIND_HOST) ?? "127.0.0.1";
  return {
    port,
    bindHost,
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
    // Copilot / companion HTTP chat (REST). Flash-Lite = highest free-tier RPD for short turns.
    geminiModel: nonempty(env.GEMINI_MODEL) ?? "gemini-3.5-flash-lite",
    geminiOverviewModel: nonempty(env.GEMINI_OVERVIEW_MODEL) ?? "gemini-3.5-flash",
    // Voice companion Live only (`/v1/companion/live`). Not used for HTTP Copilot text.
    geminiLiveModel: nonempty(env.GEMINI_LIVE_MODEL) ?? "gemini-3.8-live",
    xaiApiKey: nonempty(env.XAI_API_KEY),
    xaiTtsVoice: nonempty(env.XAI_TTS_VOICE) ?? "eve",
    presageApiKey: nonempty(env.PRESAGE_API_KEY),
    // Default gemini keeps cloud companion; set LOCAL_CHAT_PROVIDER=ollama to force Llama.
    localChatProvider: parseLocalChatProvider(env.LOCAL_CHAT_PROVIDER),
    // Default local Ollama when unset. Set OLLAMA_BASE_URL= (empty) to disable the proxy.
    ollamaBaseUrl:
      env.OLLAMA_BASE_URL === undefined
        ? "http://127.0.0.1:11434"
        : nonempty(env.OLLAMA_BASE_URL),
    coachApiToken: nonempty(env.COACH_API_TOKEN),
    ollamaModel: nonempty(env.OLLAMA_MODEL) ?? "qwen2.5:0.5b",
    ollamaVisionModel: nonempty(env.OLLAMA_VISION_MODEL) ?? "moondream",
    // 7B Q4 is a good M1/server default: long context + calendar/Drive prompts without Gemini.
    ollamaChatModel: nonempty(env.OLLAMA_CHAT_MODEL) ?? "qwen2.5:7b",
    ollamaChatNumCtx: positiveInt(env.OLLAMA_CHAT_NUM_CTX, 16384),
    adminPassword: nonempty(env.ADMIN_PASSWORD),
    production: (env.NODE_ENV ?? "").trim().toLowerCase() === "production",
    trustProxy: parseEnvFlag(env.TRUST_PROXY),
    ollamaAllowedModels: (env.OLLAMA_ALLOWED_MODELS ?? "")
      .split(",")
      .map((model) => model.trim())
      .filter((model) => model.length > 0),
  };
}

export function smtpConfigured(config: Config): boolean {
  return Boolean(
    config.smtpHost && config.smtpPort !== null && config.smtpUser && config.smtpPass && config.mailFrom,
  );
}

export function googleConfigured(config: Config): boolean {
  return config.googleClientId !== null && config.googleClientSecret !== null;
}
