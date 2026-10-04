import type { Config } from "../config.ts";
import { HttpError } from "../http.ts";
import type { FetchLike } from "../http.ts";
import type { ChatTurn } from "./chat.ts";

const CHAT_TIMEOUT_MS = 180_000;

export type ChatBackend = "ollama" | "gemini";

/**
 * Explicit provider selection for Copilot chat.
 * - localChatProvider=ollama → always Ollama (no cloud call).
 * - localChatProvider=gemini → Gemini when keyed; else Ollama if configured.
 */
export function selectChatBackend(config: Pick<
  Config,
  "localChatProvider" | "geminiApiKey" | "ollamaBaseUrl"
>): ChatBackend {
  if (config.localChatProvider === "ollama") {
    return "ollama";
  }
  if (config.geminiApiKey) {
    return "gemini";
  }
  if (config.ollamaBaseUrl) {
    return "ollama";
  }
  return "gemini";
}

/** True when chat must not touch Gemini (local Llama mode). */
export function isLocalChatForced(config: Pick<Config, "localChatProvider">): boolean {
  return config.localChatProvider === "ollama";
}

export async function ollamaChat(input: {
  baseUrl: string;
  model: string;
  system: string;
  history: ChatTurn[];
  message: string;
  numCtx: number;
  fetchImpl: FetchLike;
}): Promise<string> {
  const base = input.baseUrl.replace(/\/+$/, "");
  const messages: Array<{ role: string; content: string }> = [];
  if (input.system.trim()) {
    messages.push({ role: "system", content: input.system });
  }
  for (const turn of input.history) {
    if (turn.role === "system") continue;
    messages.push({
      role: turn.role === "assistant" ? "assistant" : "user",
      content: turn.content,
    });
  }
  messages.push({ role: "user", content: input.message });

  let response: Response;
  try {
    response = await input.fetchImpl(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        model: input.model,
        messages,
        stream: false,
        options: {
          temperature: 0.4,
          num_ctx: input.numCtx,
        },
      }),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new HttpError(
      502,
      "local_chat_unreachable",
      `Local coach unavailable (${detail}). Is Ollama running with model ${input.model}?`,
    );
  }

  const payload = (await response.json().catch(() => null)) as {
    message?: { content?: string };
    error?: string;
  } | null;

  if (!response.ok) {
    const msg = payload?.error ?? `HTTP ${response.status}`;
    throw new HttpError(502, "local_chat_failed", `Local coach failed: ${msg}`);
  }

  const text = payload?.message?.content?.trim() ?? "";
  if (!text) {
    throw new HttpError(502, "local_chat_empty", "Local coach returned an empty reply.");
  }
  return text;
}

/** Gemini failures where a silent local fallback is better than user friction. */
export function shouldFallbackToLocal(error: unknown): boolean {
  if (!(error instanceof HttpError)) return false;
  if (
    error.code === "gemini_quota" ||
    error.code === "gemini_unreachable" ||
    error.code === "gemini_empty" ||
    error.code === "gemini_not_configured"
  ) {
    return true;
  }
  if (error.code === "gemini_failed") {
    const msg = error.message.toLowerCase();
    return (
      error.status === 429 ||
      error.status === 503 ||
      /quota|resource.exhausted|unavailable|high demand|overloaded|timed? ?out/i.test(msg)
    );
  }
  return false;
}
