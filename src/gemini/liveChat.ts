/**
 * One-shot Gemini Live WebSocket chat for Copilot / companion HTTP text.
 *
 * Each call opens its own upstream Live session with the request's system + history.
 * Concurrent users never share sockets or conversation state.
 */

import WebSocket from "ws";

import {
  chatTurnsMessage,
  errorMessage,
  liveWsUrl,
  setupTextLiveMessage,
  signalsFromMessage,
  type LiveChatTurn,
} from "../companion/geminiLive.ts";
import { connectGemini } from "../companion/liveSession.ts";
import { HttpError } from "../http.ts";

const SETUP_TIMEOUT_MS = 20_000;
const REPLY_TIMEOUT_MS = 60_000;

export type LiveChatInput = {
  apiKey: string;
  model: string;
  system: string;
  history: LiveChatTurn[];
  message: string;
  /** Override Live WS URL (tests). */
  url?: string;
  setupTimeoutMs?: number;
  replyTimeoutMs?: number;
};

function closeQuietly(socket: WebSocket | null | undefined): void {
  if (!socket) return;
  try {
    if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
    else if (socket.readyState === WebSocket.OPEN) socket.close();
  } catch {
    /* ignore */
  }
}

function mapLiveError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (/quota|resource.exhausted|429/i.test(message)) {
    return new HttpError(
      429,
      "gemini_quota",
      "Cloud coach hit today’s free limit. Try again tomorrow, or keep using local lock-in coaching.",
    );
  }
  if (/timed? ?out|ECONNREFUSED|ENOTFOUND|closed before|closed during/i.test(message)) {
    return new HttpError(502, "gemini_unreachable", "Could not reach Gemini.");
  }
  return new HttpError(502, "gemini_failed", message || "Gemini Live chat failed.");
}

/**
 * Open a private Live TEXT session for this request only, collect one reply, close.
 */
export async function geminiLiveChat(input: LiveChatInput): Promise<string> {
  let gemini: WebSocket | null = null;
  try {
    gemini = await connectGemini(input.apiKey, input.model, input.system, {
      url: input.url ?? liveWsUrl(input.apiKey),
      timeoutMs: input.setupTimeoutMs ?? SETUP_TIMEOUT_MS,
      buildSetup: setupTextLiveMessage,
    });

    const reply = await collectLiveTextReply(gemini, input);
    return reply;
  } catch (error) {
    throw mapLiveError(error);
  } finally {
    closeQuietly(gemini);
  }
}

function collectLiveTextReply(gemini: WebSocket, input: LiveChatInput): Promise<string> {
  const timeoutMs = input.replyTimeoutMs ?? REPLY_TIMEOUT_MS;
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let assistant = "";
    const fragments: string[] = [];

    const finish = (error?: Error, text?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      gemini.off("message", onMessage);
      gemini.off("close", onClose);
      gemini.off("error", onError);
      if (error) {
        reject(error);
        return;
      }
      const out = (text ?? fragments.join("")).trim();
      if (!out) {
        reject(new HttpError(502, "gemini_empty", "Gemini returned an empty reply."));
        return;
      }
      resolve(out);
    };

    const timer = setTimeout(
      () => finish(new Error("timed out waiting for Gemini Live reply")),
      timeoutMs,
    );

    const onMessage = (data: WebSocket.RawData) => {
      let payload: unknown;
      try {
        payload = JSON.parse(String(data));
      } catch {
        return;
      }
      const err = errorMessage(payload);
      if (err) {
        finish(new Error(err));
        return;
      }
      const record = payload as Record<string, unknown>;
      if (record.goAway != null || record.go_away != null) {
        finish(new Error("Gemini Live ended the session early"));
        return;
      }
      for (const signal of signalsFromMessage(payload)) {
        if (signal.kind === "assistant_fragment") {
          fragments.push(signal.text);
          assistant += signal.text;
        } else if (signal.kind === "turn_complete") {
          finish(undefined, assistant || fragments.join(""));
          return;
        } else if (signal.kind === "interrupted") {
          finish(new Error("Gemini Live reply was interrupted"));
          return;
        }
      }
    };

    const onClose = () => {
      if (assistant.trim() || fragments.length) {
        finish(undefined, assistant || fragments.join(""));
        return;
      }
      finish(new Error("Gemini closed before a reply"));
    };
    const onError = (error: Error) => finish(error);

    gemini.on("message", onMessage);
    gemini.once("close", onClose);
    gemini.once("error", onError);

    try {
      gemini.send(JSON.stringify(chatTurnsMessage(input.history, input.message)));
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
