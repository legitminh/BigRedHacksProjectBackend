import { googleConfigured, type Config } from "../config.ts";
import type { FetchLike } from "../gemini/ephemeral.ts";
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

const DEFAULT_TTL_SECONDS = 30;
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
    return n === name || n.startsWith(`${name}:`) || n.startsWith(`${name}`);
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
      detail: "GEMINI_API_KEY missing on the API server",
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
  const cacheKey = `${config.ollamaBaseUrl ?? ""}|${config.ollamaModel}|${config.ollamaChatModel}`;
  const cached = cacheGet(ollamaCache, cacheKey, nowMs);
  if (cached) return cached;

  if (!config.ollamaBaseUrl) {
    const result: ProbeResult = {
      state: "err",
      status: "Offline",
      detail: "OLLAMA_BASE_URL unset — lock-in coach disabled",
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
      const chat = modelListed(json, config.ollamaChatModel);
      if (lockIn && chat) {
        result = {
          state: "ok",
          status: "Connected",
          detail: `Coach ${config.ollamaModel} + chat fallback ${config.ollamaChatModel} ready`,
        };
      } else if (lockIn) {
        result = {
          state: "warn",
          status: "Degraded",
          detail: `Coach ${config.ollamaModel} ready; pull ${config.ollamaChatModel} for Copilot fallback`,
        };
      } else if (chat) {
        result = {
          state: "warn",
          status: "Degraded",
          detail: `Chat fallback ${config.ollamaChatModel} ready; pull ${config.ollamaModel} for lock-in`,
        };
      } else {
        result = {
          state: "err",
          status: "Offline",
          detail: `Ollama up but missing ${config.ollamaModel} (and ${config.ollamaChatModel})`,
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
    : { state: "err", status: "Offline", detail: "GEMINI_API_KEY missing on the API server" };
}

/** Anonymous Ollama row — reflects configuration only (never calls Ollama). */
function configOnlyOllama(config: Config): ProbeResult {
  return config.ollamaBaseUrl
    ? { state: "ok", status: "Configured", detail: "Lock-in coach configured — sign in for a live check" }
    : { state: "err", status: "Offline", detail: "OLLAMA_BASE_URL unset — lock-in coach disabled" };
}

function apiIndicator(store: Store): ServiceIndicator {
  return {
    id: "api",
    label: "Waypoint API",
    state: "ok",
    status: "Connected",
    detail: `Process up · storage ${store.kind}`,
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
    detail: ready
      ? "OAuth client configured for Waypoint login"
      : "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing",
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
      detail: forced
        ? `LOCAL_CHAT_PROVIDER=ollama · ${ollama.detail}`
        : `Using Ollama chat (${config.ollamaChatModel}) · ${ollama.detail}`,
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
      detail: `Gemini primary (${config.geminiModel}); Ollama fallback ${
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
    accountIndicator(deps.user),
    googleOauthIndicator(deps.config),
    apiIndicator(deps.store),
  ];

  // Gemini-only failures do not flip ok when Copilot can fall back (chat_provider).
  const critical = new Set(["api", "google_oauth", "ollama", "chat_provider"]);
  const hardDown = services.some((s) => critical.has(s.id) && s.state === "err");
  return {
    ok: !hardDown,
    checked_at: now.toISOString(),
    cache_ttl_seconds: DEFAULT_TTL_SECONDS,
    services,
  };
}
