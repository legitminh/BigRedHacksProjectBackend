/**
 * Orders text sent to Grok so barge-in cannot be spoken over by in-flight audio,
 * and the next sentence waits until the current utterance finishes.
 * Ported from legitminh/gemini_live_demo (speech.rs).
 */

import { textClear, textDelta, textDone, type GrokEvent } from "./grokTts.ts";

type Queued = { kind: "delta"; text: string } | { kind: "done" };

export type SpeechAction =
  | { type: "send"; message: string }
  | { type: "audio"; bytes: Buffer; epoch: number }
  | { type: "ended"; epoch: number }
  | { type: "cleared"; epoch: number }
  | { type: "failed"; message: string };

export class SpeechQueue {
  epoch = 1;
  /** Drop audio until Grok acknowledges text.clear. */
  private discard = false;
  /** text.done was sent and audio.done has not arrived yet. */
  private awaitingAudio = false;
  private pending: Queued[] = [];
  private opened = false;
  private playbackEpoch: number | null = null;

  isBusy(): boolean {
    return this.opened || this.awaitingAudio || this.discard || this.pending.length > 0;
  }

  /** True the first time audio for this epoch is played. */
  notePlayback(epoch: number): boolean {
    if (this.playbackEpoch === epoch) return false;
    this.playbackEpoch = epoch;
    return true;
  }

  speak(text: string): SpeechAction[] {
    if (!text) return [];
    if (this.discard || this.awaitingAudio) {
      this.pending.push({ kind: "delta", text });
      return [];
    }
    this.opened = true;
    return [{ type: "send", message: textDelta(text) }];
  }

  finish(): SpeechAction[] {
    if (this.discard || this.awaitingAudio) {
      if (this.pending.some((item) => item.kind === "delta")) {
        this.pending.push({ kind: "done" });
      }
      return [];
    }
    if (!this.opened) return [];
    this.opened = false;
    this.awaitingAudio = true;
    return [{ type: "send", message: textDone() }];
  }

  /** Speak chunks in order; each chunk is its own text.delta → text.done utterance. */
  speakUtterances(chunks: string[]): SpeechAction[] {
    const actions: SpeechAction[] = [];
    for (const chunk of chunks) {
      if (!chunk) continue;
      actions.push(...this.speak(chunk));
      actions.push(...this.finish());
    }
    return actions;
  }

  cancel(): SpeechAction[] {
    if (!this.isBusy()) return [];
    this.pending = [];
    this.opened = false;
    this.awaitingAudio = false;
    this.playbackEpoch = null;
    this.discard = true;
    this.epoch = (this.epoch + 1) >>> 0 || 1;
    return [
      { type: "send", message: textClear() },
      { type: "cleared", epoch: this.epoch },
    ];
  }

  /** Give up waiting for audio.clear and speak anything queued behind it. */
  forceReady(): SpeechAction[] {
    if (!this.discard && !this.awaitingAudio) return [];
    this.awaitingAudio = false;
    return this.flushPending();
  }

  onGrok(event: GrokEvent): SpeechAction[] {
    switch (event.kind) {
      case "audio":
        if (this.discard || event.bytes.length === 0) return [];
        return [{ type: "audio", bytes: event.bytes, epoch: this.epoch }];
      case "done": {
        this.awaitingAudio = false;
        if (this.discard) return this.flushPending();
        const next = this.flushPending();
        // More utterances queued — keep speaking; only signal ended when idle.
        if (next.length > 0) return next;
        return [{ type: "ended", epoch: this.epoch }];
      }
      case "cleared":
        this.awaitingAudio = false;
        return this.flushPending();
      case "error":
        this.awaitingAudio = false;
        this.opened = false;
        if (this.discard) {
          return [{ type: "failed", message: event.message }, ...this.flushPending()];
        }
        return [{ type: "failed", message: event.message }];
      case "ignore":
        return [];
    }
  }

  /** Start at most one pending utterance (delta…done); leave the rest queued. */
  private flushPending(): SpeechAction[] {
    this.discard = false;
    const actions: SpeechAction[] = [];
    while (this.pending.length > 0) {
      const item = this.pending.shift()!;
      if (item.kind === "delta") {
        this.opened = true;
        actions.push({ type: "send", message: textDelta(item.text) });
      } else if (this.opened) {
        this.opened = false;
        this.awaitingAudio = true;
        actions.push({ type: "send", message: textDone() });
        break;
      }
    }
    return actions;
  }
}
