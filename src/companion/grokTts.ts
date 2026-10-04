/**
 * Streaming Grok / xAI TTS WebSocket — ported from legitminh/gemini_live_demo (grok.rs).
 * Codec: PCM s16le @ 24 kHz. Auth: Bearer XAI_API_KEY.
 */

import WebSocket from "ws";

const CONNECT_TIMEOUT_MS = 20_000;

export type GrokEvent =
  | { kind: "audio"; bytes: Buffer }
  | { kind: "done" }
  | { kind: "cleared" }
  | { kind: "error"; message: string }
  | { kind: "ignore" };

function safeToken(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value);
}

export function grokTtsStreamUrl(voice: string, language: string): string {
  if (!safeToken(voice)) throw new Error("Voice id contains unsupported characters");
  if (!safeToken(language)) throw new Error("Language code contains unsupported characters");
  return (
    `wss://api.x.ai/v1/tts?language=${encodeURIComponent(language)}` +
    `&voice=${encodeURIComponent(voice)}` +
    `&codec=pcm&sample_rate=24000&speed=1.0` +
    `&optimize_streaming_latency=1&text_normalization=true`
  );
}

export function textDelta(text: string): string {
  return JSON.stringify({ type: "text.delta", delta: text });
}

export function textDone(): string {
  return JSON.stringify({ type: "text.done" });
}

export function textClear(): string {
  return JSON.stringify({ type: "text.clear" });
}

export function parseGrokEvent(payload: string): GrokEvent {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return { kind: "error", message: "Grok sent a message that was not JSON" };
  }
  if (!value || typeof value !== "object") return { kind: "ignore" };
  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  switch (type) {
    case "audio.delta": {
      const encoded = typeof record.delta === "string" ? record.delta : "";
      try {
        const bytes = Buffer.from(encoded, "base64");
        return { kind: "audio", bytes };
      } catch {
        return { kind: "error", message: "Grok audio chunk was not valid base64" };
      }
    }
    case "audio.done":
      return { kind: "done" };
    case "audio.clear":
      return { kind: "cleared" };
    case "session.updated":
      return { kind: "ignore" };
    case "error": {
      const message =
        typeof record.message === "string" && record.message.trim()
          ? record.message.trim()
          : "Grok Voice returned an error";
      return { kind: "error", message };
    }
    default:
      return { kind: "ignore" };
  }
}

export async function connectGrokTts(
  apiKey: string,
  voice: string,
  language = "en",
): Promise<WebSocket> {
  const url = grokTtsStreamUrl(voice, language);
  const socket = new WebSocket(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  socket.on("error", () => {});

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out connecting to Grok Voice")),
      CONNECT_TIMEOUT_MS,
    );
    const onClose = () => {
      clearTimeout(timer);
      reject(new Error("Grok closed before connecting"));
    };
    socket.once("open", () => {
      clearTimeout(timer);
      socket.off("close", onClose);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("close", onClose);
  });

  return socket;
}

export const GROK_TTS_SAMPLE_RATE = 24_000;
/** Hard clip before TTS to limit free-tier xAI spend. */
export const GROK_TTS_MAX_CHARS = 300;
