import { googleConfigured, type Config } from "../config.ts";
import type { FetchLike } from "../http.ts";
import { selectChatBackend } from "../gemini/localChat.ts";
import type { PublicUser, Store } from "../store/types.ts";

export type ServiceState = "ok" | "warn" | "err";

export type ServiceIndicator = {
  id: string;
  label: string;
  state: ServiceState;
  /** Short badge copy for the UI (Connected / Offline / Quota / …). */
  status: string;
  detail: string;
  optional: boolean;
};

export type StatusResponse = {
  ok: boolean;
  checked_at: string;
  /** Client hint: how long probe results may be reused server-side. */
  cache_ttl_seconds: number;
  services: ServiceIndicator[];
};

export type StatusDeps = {
  config: Config;
  store: Store;
  fetch: FetchLike;
  /** Present when the request carries a valid JWT. */
  user: PublicUser | null;
  googleConnected: boolean | null;
  now?: () => Date;
};

/** Longer TTL: listModels probes still count against Gemini free-tier RPM. */
const DEFAULT_TTL_SECONDS = 300;
const GEMINI_PROBE_TIMEOUT_MS = 5_000;
const OLLAMA_PROBE_TIMEOUT_MS = 5_000;

type ProbeResult = {
  state: ServiceState;
  status: string;
  detail: string;
};

type CacheEntry = {
  expiresAt: number;
  result: ProbeResult;
};

const geminiCache = new Map<string, CacheEntry>();
const ollamaCache = new Map<string, CacheEntry>();

/** Test helper — clears in-process probe caches. */
export function clearStatusCaches(): void {
  geminiCache.clear();
  ollamaCache.clear();
}

function cacheGet(map: Map<string, CacheEntry>, key: string, nowMs: number): ProbeResult | null {
  const hit = map.get(key);
  if (!hit || nowMs >= hit.expiresAt) return null;
  return hit.result;
}

function cacheSet(
  map: Map<string, CacheEntry>,
  key: string,
  result: ProbeResult,
  nowMs: number,
  ttlSeconds: number,
): void {
  map.set(key, { expiresAt: nowMs + ttlSeconds * 1000, result });
}

function modelListed(tagsJson: unknown, wanted: string): boolean {
  const name = wanted.trim().toLowerCase();
  if (!name) return false;
  const models = (tagsJson as { models?: Array<{ name?: string; model?: string }> } | null)?.models;
  if (!Array.isArray(models)) return false;
  return models.some((m) => {
    const n = (m.name ?? m.model ?? "").toLowerCase();
    // Exact or tagged (`moondream:latest`) / digest (`moondream@sha256:…`) — not bare prefix
    // (`moondream` must not match `moondream2`).
    return n === name || n.startsWith(`${name}:`) || n.startsWith(`${name}@`);
  });
}

async function probeGemini(config: Config, fetchImpl: FetchLike, nowMs: number): Promise<ProbeResult> {
  const ttl = DEFAULT_TTL_SECONDS;
  const cacheKey = config.geminiApiKey ?? "";
  const cached = cacheGet(geminiCache, cacheKey, nowMs);
  if (cached) return cached;

  if (!config.geminiApiKey) {
    const result: ProbeResult = {
      state: "err",
      status: "Offline",
      detail: "Cloud coach is not set up on this server",
    };
    cacheSet(geminiCache, cacheKey, result, nowMs, ttl);
    return result;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${encodeURIComponent(config.geminiApiKey)}`;
  let result: ProbeResult;
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(GEMINI_PROBE_TIMEOUT_MS),
    });
    const payload = (await response.json().catch(() => null)) as {
      error?: { message?: string; status?: string };
      models?: unknown[];
    } | null;
    if (response.ok) {
      result = {
        state: "ok",
        status: "Connected",
        detail: `Cloud coach ready (${config.geminiModel})`,
      };
    } else {
      const msg = payload?.error?.message ?? `HTTP ${response.status}`;
      const quota =
        response.status === 429 || /resource.exhausted|quota|rate limit/i.test(msg);
      result = {
        state: quota ? "err" : "warn",
        status: quota ? "Quota" : "Offline",
        detail: quota ? `Gemini quota: ${msg}` : `Gemini probe failed: ${msg}`,
      };
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    result = {
      state: "warn",
      status: "Offline",
      detail: `Could not reach Gemini (${detail})`,
    };
  }
  cacheSet(geminiCache, cacheKey, result, nowMs, ttl);
  return result;
}

async function probeOllama(config: Config, fetchImpl: FetchLike, nowMs: number): Promise<ProbeResult> {
  const ttl = DEFAULT_TTL_SECONDS;
  const cacheKey = `${config.ollamaBaseUrl ?? ""}|${config.ollamaModel}|${config.ollamaVisionModel}|${config.ollamaChatModel}`;
  const cached = cacheGet(ollamaCache, cacheKey, nowMs);
  if (cached) return cached;

  if (!config.ollamaBaseUrl) {
    const result: ProbeResult = {
      state: "err",
      status: "Offline",
      detail: "Lock-in coach is not set up on this server",
    };
    cacheSet(ollamaCache, cacheKey, result, nowMs, ttl);
    return result;
  }

  const base = config.ollamaBaseUrl.replace(/\/+$/, "");
  let result: ProbeResult;
  try {
    const response = await fetchImpl(`${base}/api/tags`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(OLLAMA_PROBE_TIMEOUT_MS),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok) {
      result = {
        state: "err",
        status: "Offline",
        detail: `Ollama returned HTTP ${response.status}`,
      };
    } else {
      const lockIn = modelListed(json, config.ollamaModel);
      const vision = modelListed(json, config.ollamaVisionModel);
      const chat = modelListed(json, config.ollamaChatModel);
      const missing = [
        !lockIn ? config.ollamaModel : null,
        !vision ? config.ollamaVisionModel : null,
        !chat ? config.ollamaChatModel : null,
      ].filter((name): name is string => Boolean(name));
      if (missing.length === 0) {
        result = {
          state: "ok",
          status: "Connected",
          detail: `Coach ${config.ollamaModel} · vision ${config.ollamaVisionModel} · chat ${config.ollamaChatModel}`,
        };
      } else if (lockIn || chat) {
        result = {
          state: "warn",
          status: "Degraded",
          detail: `Ollama missing ${missing.join(", ")}`,
        };
      } else {
        result = {
          state: "err",
          status: "Offline",
          detail: `Ollama up but missing ${missing.join(", ")}`,
        };
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    result = {
      state: "err",
      status: "Offline",
      detail: `Could not reach Ollama at ${base} (${detail})`,
    };
  }
  cacheSet(ollamaCache, cacheKey, result, nowMs, ttl);
  return result;
}

/** Anonymous Gemini row — reflects configuration only (never calls Google). */
function configOnlyGemini(config: Config): ProbeResult {
  return config.geminiApiKey
    ? { state: "ok", status: "Configured", detail: "Cloud coach configured — sign in for a live check" }
    : { state: "err", status: "Offline", detail: "Cloud coach is not set up on this server" };
}

/** Anonymous Ollama row — reflects configuration only (never calls Ollama). */
function configOnlyOllama(config: Config): ProbeResult {
  return config.ollamaBaseUrl
    ? { state: "ok", status: "Configured", detail: "Lock-in coach configured — sign in for a live check" }
    : { state: "err", status: "Offline", detail: "Lock-in coach is not set up on this server" };
}

function apiIndicator(store: Store): ServiceIndicator {
  return {
    id: "api",
    label: "Waypoint API",
    state: "ok",
    status: "Connected",
    detail: "Waypoint API is running",
    optional: false,
  };
}

/** Config-only — no outbound Presage probe (key presence only). */
function presageIndicator(config: Config): ServiceIndicator {
  if (config.presageApiKey) {
    return {
      id: "presage",
      label: "Presage",
      state: "ok",
      status: "Configured",
      detail: "Camera accountability vitals ready",
      optional: true,
    };
  }
  return {
    id: "presage",
    label: "Presage",
    state: "warn",
    status: "Degraded",
    detail: "PRESAGE_API_KEY unset — presence heuristics only; vitals unavailable",
    optional: true,
  };
}

/** Config-only — Grok TTS key presence (heads-ups fall back to macOS say; Live does not). */
function xaiIndicator(config: Config): ServiceIndicator {
  if (config.xaiApiKey) {
    return {
      id: "xai_tts",
      label: "Grok voice",
      state: "ok",
      status: "Configured",
      detail: `Heads-up TTS + Live speak ready (${config.xaiTtsVoice})`,
      optional: true,
    };
  }
  return {
    id: "xai_tts",
    label: "Grok voice",
    state: "warn",
    status: "Degraded",
    detail: "XAI_API_KEY unset — Talk/Live unavailable; heads-ups fall back to macOS say",
    optional: true,
  };
}

/**
 * Talk / Live voice readiness. Gemini Live + Grok TTS are both required at runtime;
 * this row surfaces that clearly even when `xai_tts` stays optional for heads-up fallback.
 */
function companionLiveIndicator(config: Config, gemini: ProbeResult): ServiceIndicator {
  if (!config.geminiApiKey) {
    return {
      id: "companion_live",
      label: "Talk / Live voice",
      state: "err",
      status: "Offline",
      detail: "GEMINI_API_KEY unset — Live companion unavailable",
      optional: true,
    };
  }
  if (!config.xaiApiKey) {
    return {
      id: "companion_live",
      label: "Talk / Live voice",
      state: "warn",
      status: "Unavailable",
      detail: "Needs XAI_API_KEY (Grok) plus Gemini Live — Talk will not connect",
      optional: true,
    };
  }
  if (gemini.state === "err") {
    return {
      id: "companion_live",
      label: "Talk / Live voice",
      state: "warn",
      status: "Degraded",
      detail: `Gemini Live model ${config.geminiLiveModel} not reachable`,
      optional: true,
    };
  }
  return {
    id: "companion_live",
    label: "Talk / Live voice",
    state: "ok",
    status: "Ready",
    detail: `Live ready (${config.geminiLiveModel} + Grok ${config.xaiTtsVoice})`,
    optional: true,
  };
}

function storageIndicator(config: Config): ServiceIndicator {
  if (config.databaseUrl) {
    return {
      id: "storage",
      label: "TigerData",
      state: "ok",
      status: "Configured",
      detail: "Postgres / TigerData URL set",
      optional: false,
    };
  }
  return {
    id: "storage",
    label: "TigerData",
    state: "warn",
    status: "Local file",
    detail: "DATABASE_URL unset — using local file store",
    optional: false,
  };
}

function googleOauthIndicator(config: Config): ServiceIndicator {
  const ready = googleConfigured(config);
  return {
    id: "google_oauth",
    label: "Google sign-in",
    state: ready ? "ok" : "err",
    status: ready ? "Connected" : "Offline",
    detail: ready ? "Google sign-in is ready" : "Google sign-in is not set up on this server",
    optional: false,
  };
}

function accountIndicator(user: PublicUser | null): ServiceIndicator {
  if (!user) {
    return {
      id: "account",
      label: "Waypoint account",
      state: "warn",
      status: "Offline",
      detail: "Sign in with Google to unlock the app",
      optional: false,
    };
  }
  const who = user.email || user.name || user.id;
  return {
    id: "account",
    label: "Waypoint account",
    state: "ok",
    status: "Connected",
    detail: `Signed in as ${who}`,
    optional: false,
  };
}

function googleDataIndicator(
  user: PublicUser | null,
  googleConnected: boolean | null,
): ServiceIndicator {
  if (!user) {
    return {
      id: "google",
      label: "Google",
      state: "warn",
      status: "Offline",
      detail: "Required — sign in with Google on the welcome screen",
      optional: false,
    };
  }
  if (googleConnected) {
    return {
      id: "google",
      label: "Google",
      state: "ok",
      status: "Connected",
      detail: "Calendar and Drive linked for Copilot",
      optional: false,
    };
  }
  return {
    id: "google",
    label: "Google",
    state: "warn",
    status: "Offline",
    detail: "Required — re-link Calendar and Drive",
    optional: false,
  };
}

/** Surfaces which Copilot chat engine is active (health only — no provider switching). */
function chatProviderIndicator(
  config: Config,
  gemini: ProbeResult,
  ollama: ProbeResult,
): ServiceIndicator {
  const backend = selectChatBackend(config);
  if (backend === "ollama") {
    const forced = config.localChatProvider === "ollama";
    return {
      id: "chat_provider",
      label: "Copilot chat",
      state: ollama.state,
      status: ollama.status,
      detail: forced ? `Local Copilot · ${ollama.detail}` : `Local Copilot (${config.ollamaChatModel}) · ${ollama.detail}`,
      optional: false,
    };
  }
  // gemini primary — warn if cloud is down but local fallback is healthy
  if (gemini.state === "ok") {
    const fallbackReady = ollama.state === "ok";
    return {
      id: "chat_provider",
      label: "Copilot chat",
      state: fallbackReady ? "ok" : "warn",
      status: fallbackReady ? "Connected" : "Degraded",
      detail: `Gemini REST primary (${config.geminiModel}); Live voice ${config.geminiLiveModel}; Ollama fallback ${
        fallbackReady ? "ready" : "unavailable"
      }`,
      optional: false,
    };
  }
  if (ollama.state === "ok" || ollama.state === "warn") {
    return {
      id: "chat_provider",
      label: "Copilot chat",
      state: "warn",
      status: "Degraded",
      detail: `Gemini ${gemini.status.toLowerCase()}; falling back to Ollama (${config.ollamaChatModel})`,
      optional: false,
    };
  }
  return {
    id: "chat_provider",
    label: "Copilot chat",
    state: "err",
    status: "Offline",
    detail: `Gemini ${gemini.status.toLowerCase()} and Ollama unavailable`,
    optional: false,
  };
}

/**
 * Aggregate live service health for the desktop Connection status panel.
 * Gemini + Ollama probes are TTL-cached and only run for signed-in users; anonymous
 * callers see config-only rows. User-scoped rows use the JWT when present.
 */
export async function aggregateStatus(deps: StatusDeps): Promise<StatusResponse> {
  const nowFn = deps.now ?? (() => new Date());
  const now = nowFn();
  const nowMs = now.getTime();

  // Anonymous callers get config-only answers: no outbound Gemini/Ollama probes, so an
  // unauthenticated client cannot burn Gemini quota or make the API host fan out requests.
  const [gemini, ollama] = deps.user
    ? await Promise.all([
        probeGemini(deps.config, deps.fetch, nowMs),
        probeOllama(deps.config, deps.fetch, nowMs),
      ])
    : [configOnlyGemini(deps.config), configOnlyOllama(deps.config)];

  const services: ServiceIndicator[] = [
    {
      id: "gemini",
      label: "Gemini coach",
      state: gemini.state,
      status: gemini.status,
      detail: gemini.detail,
      optional: false,
    },
    googleDataIndicator(deps.user, deps.googleConnected),
    {
      id: "ollama",
      label: "Lock-in coach",
      state: ollama.state,
      status: ollama.status,
      detail: ollama.detail,
      optional: false,
    },
    chatProviderIndicator(deps.config, gemini, ollama),
    companionLiveIndicator(deps.config, gemini),
    xaiIndicator(deps.config),
    accountIndicator(deps.user),
    googleOauthIndicator(deps.config),
    apiIndicator(deps.store),
    storageIndicator(deps.config),
    presageIndicator(deps.config),
  ];

  // Critical rows flip global `ok`. Ollama is only hard-critical when local chat is forced
  // (or Gemini is not the primary path); cloud-primary + Gemini healthy keeps ok true
  // even if the optional Ollama fallback probe fails. Signed-in Google disconnect is
  // product-critical for Copilot Calendar/Drive.
  const critical = new Set<string>(["api", "google_oauth", "chat_provider"]);
  const backend = selectChatBackend(deps.config);
  if (backend === "ollama" || deps.config.localChatProvider === "ollama") {
    critical.add("ollama");
  } else if (gemini.state === "err" && ollama.state === "err") {
    // Both engines down — already reflected via chat_provider err; keep ollama listed.
    critical.add("ollama");
  }
  if (deps.user) {
    critical.add("google");
  }
  // Treat Offline google (warn) as hard-down for signed-in users — Copilot needs Calendar/Drive.
  const hardDown = services.some((s) => {
    if (!critical.has(s.id)) return false;
    if (s.id === "google") return s.state === "err" || s.state === "warn";
    return s.state === "err";
  });
  return {
    ok: !hardDown,
    checked_at: now.toISOString(),
    cache_ttl_seconds: DEFAULT_TTL_SECONDS,
    services,
  };
}
