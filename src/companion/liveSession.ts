/**
 * Client WebSocket ↔ Gemini Live proxy.
 * Behavior mirrors legitminh/gemini_live_demo (session.rs), without Grok TTS —
 * Gemini native audio is forwarded to the client for playback.
 */

import WebSocket from "ws";

import type { Config } from "../config.ts";
import {
  audioMessage,
  audioStreamEndMessage,
  buildCompanionSystem,
  errorMessage,
  liveWsUrl,
  sampleRateFromMime,
  setupMessage,
  signalsFromMessage,
  textTurnMessage,
  type LiveSignal,
} from "./geminiLive.ts";

const MAX_PCM_BYTES = 64 * 1024;
const SETUP_TIMEOUT_MS = 20_000;

type Inbound =
  | { type: "start"; context?: Record<string, unknown> | null }
  | { type: "audio"; pcm: string }
  | { type: "text"; text: string }
  | { type: "barge" }
  | { type: "stop" };

type Outbound =
  | { type: "status"; phase: string }
  | { type: "ready"; model: string }
  | { type: "user"; text: string; final: boolean }
  | { type: "assistant"; text: string; final: boolean }
  | { type: "audio"; pcm: string; sample_rate: number; epoch: number }
  | { type: "audio_end"; epoch: number }
  | { type: "clear_audio"; epoch: number }
  | { type: "error"; message: string };

class TurnBridge {
  assistant = "";
  lastFragment = "";
  userCommitted = "";
  userInterim = "";
  userSentFinal = false;
  assistantSentFinal = false;

  handle(signal: LiveSignal): Outbound[] {
    switch (signal.kind) {
      case "interim_user":
        return this.interimUser(signal.text);
      case "final_user":
        return this.finalUser(signal.text);
      case "assistant_fragment":
        return this.assistantFragment(signal.text);
      case "generation_complete":
        return [];
      case "turn_complete":
        return this.completeTurn();
      case "interrupted":
        return this.interrupt();
      case "audio":
        return [];
    }
  }

  private interimUser(text: string): Outbound[] {
    const trimmed = text.trim();
    if (!trimmed) return [];
    this.userInterim = trimmed;
    this.userSentFinal = false;
    return [{ type: "user", text: this.userDisplay(), final: false }];
  }

  private finalUser(text: string): Outbound[] {
    const trimmed = text.trim();
    if (!trimmed) return [];
    const interim = this.userInterim.trim();
    const interimMatches =
      interim.length > 0 &&
      (trimmed.startsWith(interim) || interim.startsWith(trimmed) || trimmed.includes(interim));
    if (interimMatches || this.userCommitted.length === 0 || trimmed.startsWith(this.userCommitted)) {
      this.userCommitted = trimmed;
      this.userInterim = "";
    } else if (this.userCommitted.endsWith(trimmed)) {
      this.userInterim = "";
    } else {
      this.userCommitted = `${this.userCommitted}${this.userCommitted && !this.userCommitted.endsWith(" ") ? " " : ""}${trimmed}`;
      this.userInterim = "";
    }
    this.userSentFinal = true;
    return [{ type: "user", text: this.userCommitted, final: true }];
  }

  private assistantFragment(fragment: string): Outbound[] {
    if (!fragment) return [];
    this.commitUserDraft();
    const delta = this.absorbAssistant(fragment);
    const out: Outbound[] = [];
    if (!this.userSentFinal && this.userCommitted) {
      this.userSentFinal = true;
      out.push({ type: "user", text: this.userCommitted, final: true });
    }
    if (this.assistant) {
      this.assistantSentFinal = false;
      out.push({ type: "assistant", text: this.assistant, final: false });
    }
    void delta;
    return out;
  }

  private absorbAssistant(fragment: string): string {
    if (fragment === this.lastFragment) return "";
    if (
      fragment.startsWith(this.assistant) &&
      fragment.length > this.assistant.length
    ) {
      const delta = fragment.slice(this.assistant.length);
      this.assistant = fragment;
      this.lastFragment = fragment;
      return delta;
    }
    this.assistant += fragment;
    this.lastFragment = fragment;
    return fragment;
  }

  private commitUserDraft(): void {
    if (!this.userCommitted && this.userInterim) {
      this.userCommitted = this.userInterim;
      this.userInterim = "";
    }
  }

  private completeTurn(): Outbound[] {
    this.commitUserDraft();
    const out: Outbound[] = [];
    if (!this.userSentFinal && this.userCommitted) {
      out.push({ type: "user", text: this.userCommitted, final: true });
    }
    if (!this.assistantSentFinal && this.assistant) {
      out.push({ type: "assistant", text: this.assistant, final: true });
      this.assistantSentFinal = true;
    }
    this.resetTurn();
    return out;
  }

  private interrupt(): Outbound[] {
    this.commitUserDraft();
    const out: Outbound[] = [];
    if (!this.userSentFinal && this.userCommitted) {
      out.push({ type: "user", text: this.userCommitted, final: true });
    }
    if (this.assistant) {
      out.push({ type: "assistant", text: this.assistant, final: true });
    }
    this.resetTurn();
    return out;
  }

  private resetTurn(): void {
    this.assistant = "";
    this.lastFragment = "";
    this.userCommitted = "";
    this.userInterim = "";
    this.userSentFinal = false;
    this.assistantSentFinal = false;
  }

  private userDisplay(): string {
    if (!this.userInterim) return this.userCommitted;
    if (!this.userCommitted || this.userInterim.startsWith(this.userCommitted)) {
      return this.userInterim;
    }
    return `${this.userCommitted}${this.userCommitted.endsWith(" ") ? "" : " "}${this.userInterim}`;
  }
}

function send(client: WebSocket, event: Outbound): void {
  if (client.readyState === WebSocket.OPEN) {
    client.send(JSON.stringify(event));
  }
}

function sendError(client: WebSocket, message: string): void {
  send(client, { type: "error", message: message.slice(0, 500) });
}

function parseInbound(raw: string): Inbound | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const type = value.type;
    if (type === "start") {
      return {
        type: "start",
        context:
          value.context && typeof value.context === "object"
            ? (value.context as Record<string, unknown>)
            : null,
      };
    }
    if (type === "audio" && typeof value.pcm === "string") {
      return { type: "audio", pcm: value.pcm };
    }
    if (type === "text" && typeof value.text === "string") {
      return { type: "text", text: value.text };
    }
    if (type === "barge") return { type: "barge" };
    if (type === "stop") return { type: "stop" };
    return null;
  } catch {
    return null;
  }
}

async function connectGemini(apiKey: string, model: string, system: string): Promise<WebSocket> {
  const gemini = new WebSocket(liveWsUrl(apiKey));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out connecting to Gemini Live")), SETUP_TIMEOUT_MS);
    gemini.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    gemini.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  gemini.send(JSON.stringify(setupMessage(model, system)));

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for Gemini setup")), SETUP_TIMEOUT_MS);
    const onMessage = (data: WebSocket.RawData) => {
      let payload: unknown;
      try {
        payload = JSON.parse(String(data));
      } catch {
        return;
      }
      const record = payload as Record<string, unknown>;
      if (record.setupComplete != null || record.setup_complete != null) {
        clearTimeout(timer);
        gemini.off("message", onMessage);
        resolve();
        return;
      }
      const err = errorMessage(payload);
      if (err) {
        clearTimeout(timer);
        gemini.off("message", onMessage);
        reject(new Error(`Gemini rejected the session: ${err}`));
      }
    };
    gemini.on("message", onMessage);
    gemini.once("close", () => {
      clearTimeout(timer);
      reject(new Error("Gemini closed during setup"));
    });
  });

  return gemini;
}

export async function runCompanionLiveSession(client: WebSocket, config: Config): Promise<void> {
  if (!config.geminiApiKey) {
    sendError(client, "GEMINI_API_KEY is not configured on the Waypoint API.");
    client.close();
    return;
  }

  let gemini: WebSocket | null = null;
  let closed = false;
  let epoch = 1;
  let geminiGenerating = false;
  let announcedReply = false;
  const bridge = new TurnBridge();
  const model = config.geminiLiveModel;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (gemini && gemini.readyState === WebSocket.OPEN) {
      try {
        gemini.send(JSON.stringify(audioStreamEndMessage()));
      } catch {
        /* ignore */
      }
      gemini.close();
    }
    gemini = null;
  };

  client.on("close", cleanup);
  client.on("error", cleanup);

  const first = await waitForStart(client);
  if (!first) {
    cleanup();
    return;
  }
  if (first.type !== "start") {
    sendError(client, "Send a start message before audio.");
    cleanup();
    client.close();
    return;
  }

  send(client, { type: "status", phase: "connecting" });
  const system = buildCompanionSystem(first.context);
  try {
    gemini = await connectGemini(config.geminiApiKey, model, system);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not open Gemini Live.";
    sendError(client, message);
    cleanup();
    client.close();
    return;
  }

  send(client, { type: "ready", model });
  send(client, { type: "status", phase: "listening" });

  gemini.on("message", (data) => {
    if (closed) return;
    let payload: unknown;
    try {
      payload = JSON.parse(String(data));
    } catch {
      return;
    }
    const err = errorMessage(payload);
    if (err) {
      sendError(client, `Gemini Live: ${err}`);
      cleanup();
      client.close();
      return;
    }
    const record = payload as Record<string, unknown>;
    if (record.goAway != null || record.go_away != null) {
      sendError(client, "Gemini Live is ending this session.");
      cleanup();
      client.close();
      return;
    }

    const signals = signalsFromMessage(payload);
    for (const signal of signals) {
      if (signal.kind === "audio") {
        send(client, {
          type: "audio",
          pcm: signal.pcmBase64,
          sample_rate: sampleRateFromMime(signal.mimeType),
          epoch,
        });
        if (!announcedReply) {
          announcedReply = true;
          send(client, { type: "status", phase: "speaking" });
        }
        continue;
      }
      if (signal.kind === "assistant_fragment") {
        geminiGenerating = true;
        if (!announcedReply) {
          announcedReply = true;
          send(client, { type: "status", phase: "thinking" });
        }
      }
      for (const event of bridge.handle(signal)) {
        send(client, event);
      }
      if (
        signal.kind === "interrupted" ||
        signal.kind === "generation_complete" ||
        signal.kind === "turn_complete"
      ) {
        if (signal.kind === "interrupted") {
          epoch += 1;
          send(client, { type: "clear_audio", epoch });
          send(client, { type: "status", phase: "listening" });
        } else if (signal.kind === "generation_complete" || signal.kind === "turn_complete") {
          send(client, { type: "audio_end", epoch });
          send(client, { type: "status", phase: "listening" });
        }
        geminiGenerating = false;
        announcedReply = false;
      }
    }
  });

  gemini.on("close", () => {
    if (closed) return;
    sendError(client, "Gemini Live closed the session.");
    cleanup();
    client.close();
  });

  client.on("message", (data) => {
    if (closed || !gemini) return;
    const inbound = parseInbound(String(data));
    if (!inbound) return;
    if (inbound.type === "stop") {
      cleanup();
      client.close();
      return;
    }
    if (inbound.type === "audio") {
      let bytes: Buffer;
      try {
        bytes = Buffer.from(inbound.pcm, "base64");
      } catch {
        return;
      }
      if (bytes.length === 0 || bytes.length > MAX_PCM_BYTES || bytes.length % 2 !== 0) return;
      if (gemini.readyState === WebSocket.OPEN) {
        gemini.send(JSON.stringify(audioMessage(bytes)));
      }
      return;
    }
    if (inbound.type === "text") {
      const text = inbound.text.trim();
      if (!text) return;
      if (gemini.readyState === WebSocket.OPEN) {
        gemini.send(JSON.stringify(textTurnMessage(text)));
      }
      send(client, { type: "user", text, final: true });
      send(client, { type: "status", phase: "thinking" });
      return;
    }
    if (inbound.type === "barge") {
      epoch += 1;
      send(client, { type: "clear_audio", epoch });
      if (geminiGenerating) {
        // Gemini activityHandling already interrupts on speech; clear local playback.
      }
      send(client, { type: "status", phase: "listening" });
    }
  });
}

function waitForStart(client: WebSocket): Promise<Inbound | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      sendError(client, "Timed out waiting for start.");
      resolve(null);
    }, 15_000);
    const onMessage = (data: WebSocket.RawData) => {
      const inbound = parseInbound(String(data));
      if (!inbound) return;
      clearTimeout(timer);
      client.off("message", onMessage);
      resolve(inbound);
    };
    client.on("message", onMessage);
    client.once("close", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}
