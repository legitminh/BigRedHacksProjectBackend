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
  /** Tool rows for the signed-in user. Null when the request has no account. */
  googleTools: { connected: number; total: number } | null;
  now?: () => Date;
};

const DEFAULT_TTL_SECONDS = 30;
const GEMINI_PROBE_TIMEOUT_MS = 5_000;
const OLLAMA_PROBE_TIMEOUT_MS = 5_000;

type ProbeResult = {
  state: ServiceState;
  status: string;
  detail: string;
  /** Ollama probe: chat model is listed and the daemon answered. */
  chatReady?: boolean;
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
  const cacheKey = `${config.ollamaBaseUrl ?? ""}|${config.ollamaModel}|${config.ollamaChatModel}`;
  const cached = cacheGet(ollamaCache, cacheKey, nowMs);
  if (cached) return cached;

  if (!config.ollamaBaseUrl) {
    const result: ProbeResult = {
      state: "err",
      status: "Offline",
      detail: "Lock-in coach is not set up on this server",
      chatReady: false,
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
        chatReady: false,
      };
    } else {
      const lockIn = modelListed(json, config.ollamaModel);
      const chat = modelListed(json, config.ollamaChatModel);
      if (lockIn && chat) {
        result = {
          state: "ok",
          status: "Connected",
          detail: `Coach ${config.ollamaModel} + chat fallback ${config.ollamaChatModel} ready`,
          chatReady: true,
        };
      } else if (lockIn) {
        result = {
          state: "warn",
          status: "Degraded",
          detail: `Coach ${config.ollamaModel} ready; pull ${config.ollamaChatModel} for Copilot fallback`,
          chatReady: false,
        };
      } else if (chat) {
        result = {
          state: "warn",
          status: "Degraded",
          detail: `Chat fallback ${config.ollamaChatModel} ready; pull ${config.ollamaModel} for lock-in`,
          chatReady: true,
        };
      } else {
        result = {
          state: "err",
          status: "Offline",
          detail: `Ollama up but missing ${config.ollamaModel} (and ${config.ollamaChatModel})`,
          chatReady: false,
        };
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    result = {
      state: "err",
      status: "Offline",
      detail: `Could not reach Ollama at ${base} (${detail})`,
      chatReady: false,
    };
  }
  cacheSet(ollamaCache, cacheKey, result, nowMs, ttl);
  return result;
}

function apiIndicator(store: Store): ServiceIndicator {
  return {
    id: "api",
    label: "Waypoint API",
    state: "ok",
    status: "Connected",
    detail: `Waypoint API is running (${store.kind} storage)`,
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
  tools: { connected: number; total: number } | null,
): ServiceIndicator {
  const separate = "Calendar and Drive are separate tools in Settings";
  if (!user || !tools) {
    return {
      id: "google",
      label: "Google",
      state: "warn",
      status: "Optional",
      detail: separate,
      optional: true,
    };
  }
  if (tools.connected <= 0) {
    return {
      id: "google",
      label: "Google",
      state: "ok",
      status: "Optional",
      detail: separate,
      optional: true,
    };
  }
  const all = tools.total > 0 && tools.connected >= tools.total;
  return {
    id: "google",
    label: "Google",
    state: "ok",
    status: all ? "Connected" : "Optional",
    detail: `${tools.connected} of ${tools.total} tools connected. ${separate}`,
    optional: true,
  };
}

/** Surfaces which Copilot chat engine is active (health only — no provider switching). */
function chatProviderIndicator(
  config: Config,
  gemini: ProbeResult,
  ollama: ProbeResult,
): ServiceIndicator {
  const backend = selectChatBackend(config);
  const chatReady = ollama.chatReady === true;
  if (backend === "ollama") {
    const forced = config.localChatProvider === "ollama";
    // Chat health follows the chat model. A missing lock-in model degrades `ollama` only.
    return {
      id: "chat_provider",
      label: "Copilot chat",
      state: chatReady ? "ok" : "err",
      status: chatReady ? "Connected" : "Offline",
      detail: forced ? `Local Copilot · ${ollama.detail}` : `Local Copilot (${config.ollamaChatModel}) · ${ollama.detail}`,
      optional: false,
    };
  }
  // gemini primary — warn if cloud is down but local fallback is healthy
  if (gemini.state === "ok") {
    return {
      id: "chat_provider",
      label: "Copilot chat",
      state: chatReady ? "ok" : "warn",
      status: chatReady ? "Connected" : "Degraded",
      detail: `Gemini REST primary (${config.geminiModel}); Live voice ${config.geminiLiveModel}; Ollama fallback ${
        chatReady ? "ready" : "unavailable"
      }`,
      optional: false,
    };
  }
  if (chatReady) {
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
 * Gemini + Ollama probes always run and are TTL-cached. A JWT only enriches account and Google.
 */
export async function aggregateStatus(deps: StatusDeps): Promise<StatusResponse> {
  const nowFn = deps.now ?? (() => new Date());
  const now = nowFn();
  const nowMs = now.getTime();

  // Blank GEMINI_API_KEY returns before any Google call. Results are cached for the TTL.
  const [gemini, ollama] = await Promise.all([
    probeGemini(deps.config, deps.fetch, nowMs),
    probeOllama(deps.config, deps.fetch, nowMs),
  ]);

  const services: ServiceIndicator[] = [
    {
      id: "gemini",
      label: "Gemini coach",
      state: gemini.state,
      status: gemini.status,
      detail: gemini.detail,
      optional: false,
    },
    googleDataIndicator(deps.user, deps.googleTools),
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
