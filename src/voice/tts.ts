import type { IncomingMessage, ServerResponse } from "node:http";

import type { Config } from "../config.ts";
import type { FetchLike } from "../gemini/ephemeral.ts";
import { HttpError, readJson, sendError, sendJson } from "../http.ts";

const XAI_TTS_URL = "https://api.x.ai/v1/tts";
/** Keep heads-up synthesis snappy; desktop falls back to local `say` on timeout. */
const TTS_TIMEOUT_MS = 4_000;
const MAX_TEXT_CHARS = 400;

export function xaiTtsConfigured(config: Config): boolean {
  return Boolean(config.xaiApiKey);
}

function parseTtsBody(body: unknown): { text: string; voiceId: string; language: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "invalid_tts", "Expected a JSON object.");
  }
  const record = body as Record<string, unknown>;
  const text = typeof record.text === "string" ? record.text.trim() : "";
  if (!text) throw new HttpError(400, "invalid_tts", "text is required.");
  const clipped = text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;
  const voiceId =
    typeof record.voice_id === "string" && record.voice_id.trim()
      ? record.voice_id.trim()
      : "";
  const language =
    typeof record.language === "string" && record.language.trim()
      ? record.language.trim()
      : "en";
  return { text: clipped, voiceId, language };
}

export async function synthesizeXaiTts(input: {
  config: Config;
  text: string;
  voiceId?: string;
  language?: string;
  fetchImpl: FetchLike;
}): Promise<{ bytes: Buffer; contentType: string }> {
  if (!input.config.xaiApiKey) {
    throw new HttpError(
      503,
      "xai_tts_not_configured",
      "Set XAI_API_KEY on the API server for Grok study heads-up voice.",
    );
  }

  const voiceId = (input.voiceId && input.voiceId.trim()) || input.config.xaiTtsVoice;
  const language = (input.language && input.language.trim()) || "en";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);

  let response: Response;
  try {
    response = await input.fetchImpl(XAI_TTS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.config.xaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: input.text,
        voice_id: voiceId,
        language,
        // Prefer quicker first audio for short coach nudges.
        optimize_streaming_latency: 1,
        speed: 1.1,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/abort/i.test(msg)) {
      throw new HttpError(504, "xai_tts_timeout", "xAI TTS timed out.");
    }
    throw new HttpError(502, "xai_tts_unreachable", "Could not reach xAI TTS.");
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const snippet = detail.trim().slice(0, 240);
    if (response.status === 401 || response.status === 403) {
      throw new HttpError(502, "xai_tts_auth", "xAI rejected the API key for TTS.");
    }
    if (response.status === 429) {
      throw new HttpError(429, "xai_tts_quota", "xAI TTS rate limit hit.");
    }
    throw new HttpError(
      502,
      "xai_tts_failed",
      snippet ? `xAI TTS failed: ${snippet}` : `xAI TTS failed (HTTP ${response.status}).`,
    );
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 32) {
    throw new HttpError(502, "xai_tts_empty", "xAI TTS returned empty audio.");
  }
  const contentType = response.headers.get("content-type") || "audio/mpeg";
  return { bytes, contentType };
}

/** Study heads-up TTS proxy — JWT or coach token (same gate as /v1/coach). */
export async function handleVoiceTts(
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
  fetchImpl: FetchLike,
  authorize: () => Promise<void>,
): Promise<boolean> {
  if (path !== "/v1/voice/tts") return false;

  try {
    if (method !== "POST") {
      throw new HttpError(405, "method_not_allowed", "Method not allowed.");
    }
    await authorize();
    const parsed = parseTtsBody(await readJson(req));
    const { bytes, contentType } = await synthesizeXaiTts({
      config,
      text: parsed.text,
      voiceId: parsed.voiceId || undefined,
      language: parsed.language,
      fetchImpl,
    });
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": bytes.length,
      "Cache-Control": "no-store",
      "X-Waypoint-Tts-Engine": "xai-grok",
    });
    res.end(bytes);
    return true;
  } catch (error) {
    if (!res.headersSent) sendError(res, error);
    return true;
  }
}

/** Lightweight readiness for ops (no audio synthesis). */
export function voiceTtsStatus(config: Config): { ok: boolean; engine: string; configured: boolean } {
  const configured = xaiTtsConfigured(config);
  return {
    ok: configured,
    engine: "xai-grok",
    configured,
  };
}

export function handleVoiceHealth(
  method: string,
  path: string,
  res: ServerResponse,
  config: Config,
): boolean {
  if (path !== "/v1/voice/health") return false;
  if (method !== "GET") {
    sendJson(res, 405, { error: { code: "method_not_allowed", message: "Method not allowed." } });
    return true;
  }
  const status = voiceTtsStatus(config);
  sendJson(res, status.configured ? 200 : 503, status);
  return true;
}
