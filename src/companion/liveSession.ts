/**
 * Client WebSocket ↔ Gemini Live (STT) + Flash-Lite (reply) + Grok TTS (voice).
 * Gemini assistant PCM is discarded; spoken audio comes from streaming Grok TTS.
 */

import WebSocket from "ws";

import type { Config } from "../config.ts";
import { geminiChat, type ChatTurn } from "../gemini/chat.ts";
import {
  AUDIO_KIND_UPLINK,
  AUDIO_PROTOCOL,
  LiveDownlink,
  tryDecodePcmFrame,
} from "./audioProtocol.ts";
import {
  audioMessage,
  audioStreamEndMessage,
  buildCompanionListenSystem,
  buildCompanionVoiceReplySystem,
  denyToolResponse,
  errorMessage,
  liveWsUrl,
  setupMessage,
  signalsFromMessage,
  toolCallsFromMessage,
  type LiveSignal,
} from "./geminiLive.ts";
import {
  connectGrokTts,
  GROK_TTS_MAX_CHARS,
  GROK_TTS_SAMPLE_RATE,
  parseGrokEvent,
} from "./grokTts.ts";
import { SpeechQueue, type SpeechAction } from "./speechQueue.ts";

const MAX_PCM_BYTES = 64 * 1024;

/**
 * `ws` delivers text frames as Buffer with `isBinary === false`.
 * Treating every Buffer as PCM drops typed turns, so the desktop never gets a spoken reply.
 */
export function splitClientMessage(
  data: WebSocket.RawData,
  isBinary: boolean,
): { uplink: Buffer | null; text: string | null } {
  if (isBinary) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    const frame = tryDecodePcmFrame(buf);
    if (!frame || frame.kind !== AUDIO_KIND_UPLINK) return { uplink: null, text: null };
    return { uplink: frame.pcm, text: null };
  }
  const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
  return { uplink: null, text };
}
const SETUP_TIMEOUT_MS = 20_000;
/** Fixed opener — no Flash-Lite spend; Grok speaks it once at Mic-on. */
const LIVE_OPENER = "I'm here. What are you working on?";
/** Hold outbound frames if the client socket is backed up; never drop samples. */
const MAX_DOWNLINK_BUFFERED_BYTES = 256 * 1024;
/** WAYPOINT_LIVE_AUDIO_DEBUG=1 logs Gemini chunk timing vs wire delivery. */
const audioDebug = ["1", "true", "yes", "on"].includes(
  (process.env.WAYPOINT_LIVE_AUDIO_DEBUG ?? "").trim().toLowerCase(),
);

export type Inbound =
  | {
      type: "start";
      context?: Record<string, unknown> | null;
      audio_protocol?: string;
    }
  | { type: "audio"; pcm: string }
  | { type: "text"; text: string }
  | { type: "barge" }
  | { type: "stop" }
  | {
      /** Legacy client reply — ignored; server never requests screencap. */
      type: "screencap";
      id: string;
      jpeg_base64?: string;
      ok?: boolean;
      error?: string;
    };

type Outbound =
  | { type: "status"; phase: string }
  | { type: "ready"; model: string; audio_protocol?: string; voice?: string }
  | { type: "user"; text: string; final: boolean }
  | { type: "assistant"; text: string; final: boolean }
  | { type: "audio"; pcm: string; sample_rate: number; epoch: number; seq?: number }
  | { type: "audio_end"; epoch: number }
  | { type: "clear_audio"; epoch: number }
  /** Desktop should speak locally (macOS say) when Grok TTS fails. */
  | { type: "speak_local"; text: string }
  | { type: "error"; message: string };

function clipForTts(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= GROK_TTS_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, GROK_TTS_MAX_CHARS - 1).trimEnd()}…`;
}

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
        audio_protocol:
          typeof value.audio_protocol === "string"
            ? value.audio_protocol
            : typeof value.audioProtocol === "string"
              ? value.audioProtocol
              : undefined,
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
    if (type === "screencap" && typeof value.id === "string") {
      return {
        type: "screencap",
        id: value.id,
        jpeg_base64:
          typeof value.jpeg_base64 === "string"
            ? value.jpeg_base64
            : typeof value.jpegBase64 === "string"
              ? value.jpegBase64
              : undefined,
        ok: typeof value.ok === "boolean" ? value.ok : undefined,
        error: typeof value.error === "string" ? value.error : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function closeQuietly(socket: WebSocket | null | undefined): void {
  if (!socket) return;
  try {
    if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
    else if (socket.readyState === WebSocket.OPEN) socket.close();
  } catch {
    /* ignore */
  }
}

export type ConnectGeminiOptions = {
  /** Override the upstream URL (tests). */
  url?: string;
  timeoutMs?: number;
  /** Default AUDIO voice setup; text chat passes setupTextLiveMessage. */
  buildSetup?: (model: string, system: string) => unknown;
  /**
   * Called synchronously with the socket *before* any await, so the caller can close it
   * (e.g. client disconnects mid-setup).
   */
  onSocket?: (socket: WebSocket) => void;
};

export async function connectGemini(
  apiKey: string,
  model: string,
  system: string,
  options: ConnectGeminiOptions = {},
): Promise<WebSocket> {
  const timeoutMs = options.timeoutMs ?? SETUP_TIMEOUT_MS;
  const buildSetup = options.buildSetup ?? setupMessage;
  const gemini = new WebSocket(options.url ?? liveWsUrl(apiKey));
  options.onSocket?.(gemini);
  // Persistent handler: a late 'error' (e.g. after abort/terminate) must never be unhandled.
  gemini.on("error", () => {});

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out connecting to Gemini Live")),
        timeoutMs,
      );
      const onClose = () => {
        clearTimeout(timer);
        reject(new Error("Gemini closed before connecting"));
      };
      gemini.once("open", () => {
        clearTimeout(timer);
        gemini.off("close", onClose);
        resolve();
      });
      gemini.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      gemini.once("close", onClose);
    });

    gemini.send(JSON.stringify(buildSetup(model, system)));

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        gemini.off("message", onMessage);
        gemini.off("close", onClose);
        gemini.off("error", onError);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(
        () => finish(new Error("timed out waiting for Gemini setup")),
        timeoutMs,
      );
      const onMessage = (data: WebSocket.RawData) => {
        let payload: unknown;
        try {
          payload = JSON.parse(String(data));
        } catch {
          return;
        }
        const record = payload as Record<string, unknown>;
        if (record.setupComplete != null || record.setup_complete != null) {
          finish();
          return;
        }
        const err = errorMessage(payload);
        if (err) finish(new Error(`Gemini rejected the session: ${err}`));
      };
      const onClose = () => finish(new Error("Gemini closed during setup"));
      const onError = (error: Error) => finish(error);
      gemini.on("message", onMessage);
      gemini.once("close", onClose);
      gemini.once("error", onError);
    });
  } catch (error) {
    // Setup timeout / rejection / failure: don't leak the upstream socket.
    closeQuietly(gemini);
    throw error;
  }

  return gemini;
}

export async function runCompanionLiveSession(client: WebSocket, config: Config): Promise<void> {
  if (!config.geminiApiKey) {
    sendError(client, "Live voice isn’t available right now. Try again later.");
    client.close();
    return;
  }
  if (!config.xaiApiKey) {
    sendError(
      client,
      "Grok voice isn’t configured on the API (set XAI_API_KEY). Live mic needs it to speak.",
    );
    client.close();
    return;
  }

  let gemini: WebSocket | null = null;
  let grok: WebSocket | null = null;
  let closed = false;
  let useBinaryAudio = false;
  let replyGen = 0;
  let clearTimer: ReturnType<typeof setTimeout> | null = null;
  const history: ChatTurn[] = [];
  const speech = new SpeechQueue();
  const downlink = new LiveDownlink(
    (frame) => {
      if (closed || client.readyState !== WebSocket.OPEN) return;
      client.send(frame);
    },
    {
      ready: () =>
        client.readyState === WebSocket.OPEN &&
        client.bufferedAmount <= MAX_DOWNLINK_BUFFERED_BYTES,
    },
  );
  const bridge = new TurnBridge();
  const liveModel = config.geminiLiveModel;
  const chatModel = config.geminiModel;
  const voiceId = config.xaiTtsVoice;
  let sessionContext: Record<string, unknown> | null = null;

  const denyUnexpectedTool = (call: { id: string; name: string }) => {
    if (!gemini || gemini.readyState !== WebSocket.OPEN) return;
    gemini.send(JSON.stringify(denyToolResponse(call)));
  };

  const clearClearTimer = () => {
    if (clearTimer == null) return;
    clearTimeout(clearTimer);
    clearTimer = null;
  };

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearClearTimer();
    downlink.reset();
    const upstream = gemini;
    if (upstream && upstream.readyState === WebSocket.OPEN) {
      try {
        upstream.send(JSON.stringify(audioStreamEndMessage()));
      } catch {
        /* ignore */
      }
    }
    closeQuietly(upstream);
    closeQuietly(grok);
    gemini = null;
    grok = null;
  };

  const applySpeechActions = (actions: SpeechAction[]) => {
    for (const action of actions) {
      switch (action.type) {
        case "send":
          if (grok && grok.readyState === WebSocket.OPEN) {
            grok.send(action.message);
          }
          break;
        case "audio": {
          if (speech.notePlayback(action.epoch)) {
            send(client, { type: "status", phase: "speaking" });
          }
          // Keep client epoch aligned with speech queue epoch.
          if (action.epoch !== downlinkEpoch()) {
            syncDownlinkEpoch(action.epoch);
          }
          downlink.push(action.bytes.toString("base64"), GROK_TTS_SAMPLE_RATE);
          break;
        }
        case "ended": {
          const turnEpoch = action.epoch;
          downlink.endStream(() => {
            if (closed || turnEpoch !== speech.epoch) return;
            send(client, { type: "audio_end", epoch: turnEpoch });
            send(client, { type: "status", phase: "listening" });
          });
          break;
        }
        case "cleared":
          syncDownlinkEpoch(action.epoch);
          send(client, { type: "clear_audio", epoch: action.epoch });
          send(client, { type: "status", phase: "listening" });
          clearClearTimer();
          clearTimer = setTimeout(() => {
            clearTimer = null;
            if (closed) return;
            applySpeechActions(speech.forceReady());
          }, 2_000);
          break;
        case "failed":
          if (audioDebug) console.warn("[live-audio] grok tts failed", action.message);
          send(client, { type: "speak_local", text: clipForTts(lastSpokenText) });
          send(client, { type: "status", phase: "listening" });
          break;
      }
    }
  };

  let downlinkEpochValue = 1;
  const downlinkEpoch = () => downlinkEpochValue;
  const syncDownlinkEpoch = (next: number) => {
    downlinkEpochValue = next;
    downlink.setEpoch(next);
  };

  let lastSpokenText = "";

  const cancelSpeech = () => {
    applySpeechActions(speech.cancel());
  };

  const speakReply = (text: string) => {
    const clipped = clipForTts(text);
    if (!clipped) return;
    lastSpokenText = clipped;
    applySpeechActions(speech.speak(clipped));
    applySpeechActions(speech.finish());
  };

  const replyToUser = async (userText: string) => {
    const trimmed = userText.trim();
    if (!trimmed || closed) return;
    const gen = (replyGen += 1);
    send(client, { type: "status", phase: "thinking" });
    cancelSpeech();
    try {
      const system = buildCompanionVoiceReplySystem(sessionContext);
      const reply = await geminiChat({
        apiKey: config.geminiApiKey!,
        model: chatModel,
        system,
        history,
        message: trimmed,
        fetchImpl: globalThis.fetch.bind(globalThis),
      });
      if (closed || gen !== replyGen) return;
      const spoken = clipForTts(reply);
      history.push({ role: "user", content: trimmed });
      history.push({ role: "assistant", content: spoken });
      while (history.length > 12) history.shift();
      send(client, { type: "assistant", text: spoken, final: true });
      speakReply(spoken);
    } catch (error) {
      if (closed || gen !== replyGen) return;
      const message =
        error instanceof Error ? error.message : "Could not get a voice reply.";
      sendError(
        client,
        /quota|429|exhausted/i.test(message)
          ? "Cloud chat hit a free-tier limit. Try again in a bit, or type."
          : "Couldn’t get a voice reply. Try again or type a message.",
      );
      send(client, { type: "status", phase: "listening" });
    }
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

  useBinaryAudio = first.audio_protocol === AUDIO_PROTOCOL;
  sessionContext =
    first.context && typeof first.context === "object" ? first.context : null;
  send(client, { type: "status", phase: "connecting" });

  const listenSystem = buildCompanionListenSystem(sessionContext);
  try {
    const upstream = await connectGemini(config.geminiApiKey, liveModel, listenSystem, {
      onSocket: (socket) => {
        gemini = socket;
      },
    });
    if (closed) {
      closeQuietly(upstream);
      return;
    }
    gemini = upstream;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not start live voice.";
    sendError(
      client,
      /gemini|api key|generativelanguage/i.test(message)
        ? "Could not start live voice. Please try again."
        : message,
    );
    cleanup();
    client.close();
    return;
  }

  try {
    grok = await connectGrokTts(config.xaiApiKey, voiceId, "en");
  } catch {
    sendError(client, "Could not connect Grok voice. Check XAI_API_KEY and try again.");
    cleanup();
    client.close();
    return;
  }
  if (closed) {
    cleanup();
    return;
  }

  grok.on("message", (data) => {
    if (closed) return;
    const raw = typeof data === "string" ? data : data.toString();
    applySpeechActions(speech.onGrok(parseGrokEvent(raw)));
  });
  grok.on("close", () => {
    if (closed) return;
    sendError(client, "Grok voice disconnected. Tap Mic to start again.");
    cleanup();
    client.close();
  });

  send(client, {
    type: "ready",
    model: `${chatModel}+grok-tts`,
    audio_protocol: useBinaryAudio ? AUDIO_PROTOCOL : undefined,
    voice: voiceId,
  });
  send(client, { type: "status", phase: "listening" });
  send(client, { type: "assistant", text: LIVE_OPENER, final: true });
  speakReply(LIVE_OPENER);

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
      sendError(client, "Live voice hit a problem. Please try again.");
      cleanup();
      client.close();
      return;
    }
    const record = payload as Record<string, unknown>;
    if (record.goAway != null || record.go_away != null) {
      sendError(client, "Live voice ended this session. Tap Mic to start again.");
      cleanup();
      client.close();
      return;
    }

    for (const call of toolCallsFromMessage(payload)) {
      denyUnexpectedTool(call);
    }

    const signals = signalsFromMessage(payload);
    for (const signal of signals) {
      // STT only — never forward Gemini assistant PCM (Grok speaks instead).
      if (signal.kind === "audio") {
        if (audioDebug) console.log("[live-audio] discard Gemini PCM chunk");
        continue;
      }
      if (signal.kind === "assistant_fragment") {
        // Ignore Gemini's spoken draft; Flash-Lite owns the reply text.
        continue;
      }
      if (signal.kind === "interim_user" || signal.kind === "final_user") {
        for (const event of bridge.handle(signal)) {
          send(client, event);
          if (event.type === "user" && event.final) {
            void replyToUser(event.text);
          }
        }
        continue;
      }
      // generation_complete / turn_complete / interrupted: no Gemini audio path.
      if (signal.kind === "interrupted" && speech.isBusy()) {
        cancelSpeech();
      }
    }
  });

  gemini.on("close", () => {
    if (closed) return;
    sendError(client, "Live voice disconnected. Tap Mic to start again.");
    cleanup();
    client.close();
  });

  const forwardUplinkPcm = (bytes: Buffer) => {
    if (bytes.length === 0 || bytes.length > MAX_PCM_BYTES || bytes.length % 2 !== 0) return;
    if (gemini && gemini.readyState === WebSocket.OPEN) {
      gemini.send(JSON.stringify(audioMessage(bytes)));
    }
  };

  client.on("message", (data, isBinary) => {
    if (closed || !gemini) return;
    const message = splitClientMessage(data, isBinary);
    if (message.uplink) {
      forwardUplinkPcm(message.uplink);
      return;
    }
    if (isBinary || message.text == null) return;
    const inbound = parseInbound(message.text);
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
      forwardUplinkPcm(bytes);
      return;
    }
    if (inbound.type === "text") {
      const text = inbound.text.trim();
      if (!text) return;
      send(client, { type: "user", text, final: true });
      void replyToUser(text);
      return;
    }
    if (inbound.type === "barge") {
      cancelSpeech();
      return;
    }
    // Legacy screencap replies: ignore.
  });
}

export function waitForStart(client: WebSocket, timeoutMs = 15_000): Promise<Inbound | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: Inbound | null) => {
      if (settled) return;
      settled = true;
      // Always detach every listener we added, whatever the outcome.
      clearTimeout(timer);
      client.off("message", onMessage);
      client.off("close", onClose);
      resolve(result);
    };
    const timer = setTimeout(() => {
      sendError(client, "Timed out waiting for start.");
      finish(null);
    }, timeoutMs);
    const onMessage = (data: WebSocket.RawData, isBinary?: boolean) => {
      if (isBinary) return;
      const inbound = parseInbound(String(data));
      if (!inbound) return;
      finish(inbound);
    };
    const onClose = () => finish(null);
    client.on("message", onMessage);
    client.once("close", onClose);
  });
}
