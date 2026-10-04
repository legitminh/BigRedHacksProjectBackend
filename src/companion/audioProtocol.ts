/**
 * Waypoint Live audio (wp1) — binary frames over the companion WebSocket.
 *
 * Layout (big-endian):
 *   magic[2] = 'W''P'
 *   version  = 1
 *   kind     = 1 downlink | 2 uplink
 *   epoch    = u32
 *   rateHz   = u32
 *   seq      = u32
 *   pcm…     = s16le mono
 *
 * Design (rebuilt): Gemini audio is forwarded as soon as ~20ms slices are ready.
 * The desktop owns 1× playback. Server-side wall-clock pacing punched holes in
 * words whenever Gemini paused between chunks.
 */

export const AUDIO_PROTOCOL = "wp1";
export const AUDIO_KIND_DOWNLINK = 1;
export const AUDIO_KIND_UPLINK = 2;

const MAGIC0 = 0x57;
const MAGIC1 = 0x50;
const VERSION = 1;
const HEADER_BYTES = 16;

/** Slice length used for framing (~20ms). Not a wall-clock pace. */
export const DOWNLINK_TICK_MS = 20;
export const DOWNLINK_SLICE_BYTES_24K = 960;
/** @deprecated */
export const DOWNLINK_MAX_CATCHUP_SLICES = 8;
/** @deprecated */
export const DOWNLINK_TARGET_BYTES = DOWNLINK_SLICE_BYTES_24K * 4;
/** @deprecated */
export const DOWNLINK_MAX_HOLD_MS = DOWNLINK_TICK_MS;

export type DecodedPcmFrame = {
  kind: number;
  epoch: number;
  sampleRate: number;
  seq: number;
  pcm: Buffer;
};

export function encodePcmFrame(
  kind: number,
  epoch: number,
  sampleRate: number,
  seq: number,
  pcm: Buffer,
): Buffer {
  const out = Buffer.allocUnsafe(HEADER_BYTES + pcm.length);
  out[0] = MAGIC0;
  out[1] = MAGIC1;
  out[2] = VERSION;
  out[3] = kind & 0xff;
  out.writeUInt32BE(epoch >>> 0, 4);
  out.writeUInt32BE(sampleRate >>> 0, 8);
  out.writeUInt32BE(seq >>> 0, 12);
  pcm.copy(out, HEADER_BYTES);
  return out;
}

export function tryDecodePcmFrame(data: Buffer): DecodedPcmFrame | null {
  if (data.length < HEADER_BYTES) return null;
  if (data[0] !== MAGIC0 || data[1] !== MAGIC1 || data[2] !== VERSION) return null;
  const kind = data[3];
  if (kind !== AUDIO_KIND_DOWNLINK && kind !== AUDIO_KIND_UPLINK) return null;
  return {
    kind,
    epoch: data.readUInt32BE(4),
    sampleRate: data.readUInt32BE(8),
    seq: data.readUInt32BE(12),
    pcm: data.subarray(HEADER_BYTES),
  };
}

function sliceBytesForRate(sampleRate: number): number {
  const rate = sampleRate > 0 ? sampleRate : 24_000;
  return Math.max(2, Math.floor((rate * DOWNLINK_TICK_MS) / 1000) * 2);
}

export type LiveDownlinkOptions = {
  /** While false, hold frames (never drop). Used for WS backpressure. */
  ready?: () => boolean;
};

/**
 * Coalesce Gemini PCM into ~20ms wp1 frames and send immediately.
 */
export class LiveDownlink {
  private buffer = Buffer.alloc(0);
  private odd: number | null = null;
  private sampleRate = 24_000;
  private epoch = 1;
  private seq = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ending = false;
  private onEnd: Array<() => void> = [];
  private sentBytes = 0;
  private readonly send: (frame: Buffer) => void;
  private readonly ready: (() => boolean) | null;

  constructor(send: (frame: Buffer) => void, options: LiveDownlinkOptions = {}) {
    this.send = send;
    this.ready = options.ready ?? null;
  }

  setEpoch(epoch: number) {
    this.reset();
    this.epoch = epoch;
    this.seq = 0;
  }

  push(pcmBase64: string, sampleRate: number) {
    let pcm: Buffer;
    try {
      pcm = Buffer.from(pcmBase64, "base64");
    } catch {
      return;
    }
    if (pcm.length === 0) return;

    if (this.odd != null) {
      pcm = Buffer.concat([Buffer.from([this.odd]), pcm]);
      this.odd = null;
    }
    if (pcm.length % 2 !== 0) {
      this.odd = pcm[pcm.length - 1] ?? null;
      pcm = pcm.subarray(0, pcm.length - 1);
    }
    if (pcm.length === 0) return;

    if (sampleRate > 0 && sampleRate !== this.sampleRate) {
      if (this.buffer.length >= 2) {
        const stale = this.buffer;
        this.buffer = Buffer.alloc(0);
        this.emit(stale);
      }
      this.sampleRate = sampleRate;
    }

    this.buffer = this.buffer.length === 0 ? pcm : Buffer.concat([this.buffer, pcm]);
    this.flush();
  }

  /** Flush everything still held, then fire callbacks. */
  endStream(onDrained?: () => void) {
    if (onDrained) this.onEnd.push(onDrained);
    this.ending = true;
    this.flush();
    if (this.buffer.length === 0 && this.odd == null) {
      this.stopRetry();
      this.finishEnd();
      return;
    }
    this.ensureRetry();
  }

  /** @deprecated */ forceFlush() {
    this.ending = true;
    this.flush(true);
    this.stopRetry();
    this.finishEnd();
  }

  reset() {
    this.stopRetry();
    this.buffer = Buffer.alloc(0);
    this.odd = null;
    this.ending = false;
    this.onEnd = [];
    this.sentBytes = 0;
  }

  bufferedMs(): number {
    const n = this.buffer.length + (this.odd != null ? 1 : 0);
    return (n / 2 / (this.sampleRate || 24_000)) * 1000;
  }

  sentMs(): number {
    return (this.sentBytes / 2 / (this.sampleRate || 24_000)) * 1000;
  }

  hasPendingAudio(): boolean {
    return this.buffer.length > 0 || this.odd != null || this.ending;
  }

  private flush(force = false) {
    const slice = sliceBytesForRate(this.sampleRate);
    while (this.buffer.length >= slice) {
      if (!force && this.ready && !this.ready()) {
        this.ensureRetry();
        return;
      }
      const pcm = this.buffer.subarray(0, slice);
      this.buffer = this.buffer.subarray(slice);
      this.emit(pcm);
    }
    if (!this.ending) {
      if (this.buffer.length === 0) this.stopRetry();
      return;
    }
    if (!force && this.ready && !this.ready()) {
      this.ensureRetry();
      return;
    }
    if (this.buffer.length >= 2) {
      const tail = this.buffer;
      this.buffer = Buffer.alloc(0);
      this.emit(tail);
    } else {
      this.buffer = Buffer.alloc(0);
    }
    this.odd = null;
    this.stopRetry();
    this.finishEnd();
  }

  private finishEnd() {
    if (!this.ending) return;
    this.ending = false;
    const cbs = this.onEnd;
    this.onEnd = [];
    for (const cb of cbs) cb();
  }

  private emit(pcm: Buffer) {
    const seq = this.seq;
    this.seq = (this.seq + 1) >>> 0;
    this.sentBytes += pcm.length;
    this.send(encodePcmFrame(AUDIO_KIND_DOWNLINK, this.epoch, this.sampleRate, seq, pcm));
  }

  private ensureRetry() {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), DOWNLINK_TICK_MS);
    if (typeof this.timer === "object" && this.timer && "unref" in this.timer) {
      (this.timer as NodeJS.Timeout).unref?.();
    }
  }

  private stopRetry() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

/** @deprecated Use {@link LiveDownlink}. */
export class PacedDownlinkStreamer extends LiveDownlink {}
/** @deprecated */
export class DownlinkAudioBatcher extends LiveDownlink {}
/** @deprecated */
export type PacedDownlinkOptions = LiveDownlinkOptions;
