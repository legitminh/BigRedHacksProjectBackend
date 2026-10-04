/**
 * Waypoint Live audio framing (wp1).
 *
 * Binary WebSocket payload (big-endian fields):
 *   magic[2] = 'W''P'
 *   version  = 1
 *   kind     = 1 downlink PCM | 2 uplink PCM
 *   epoch    = u32
 *   rate     = u32 sample rate Hz
 *   seq      = u32 monotonic per epoch
 *   pcm…     = s16le mono samples
 *
 * JSON control messages stay as text frames. Audio uses binary to avoid
 * base64 overhead. Downlink is paced at ~realtime so the desktop gets a
 * steady stream instead of bursty Gemini fragments.
 */

export const AUDIO_PROTOCOL = "wp1";
export const AUDIO_KIND_DOWNLINK = 1;
export const AUDIO_KIND_UPLINK = 2;

const MAGIC0 = 0x57; // W
const MAGIC1 = 0x50; // P
const VERSION = 1;
const HEADER_BYTES = 16;

/** One paced tick (~20ms). */
export const DOWNLINK_TICK_MS = 20;
/** Fallback slice size when sample rate is unknown (~20ms @ 24 kHz s16le). */
export const DOWNLINK_SLICE_BYTES_24K = 960;

/** @deprecated Kept for tests that assert coalesce behavior; paced streamer is used in prod. */
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
  // 20ms of mono s16le
  return Math.max(2, Math.floor((rate * DOWNLINK_TICK_MS) / 1000) * 2);
}

/**
 * Buffer Gemini PCM as it arrives, emit wp1 frames to the desktop at ~1× realtime.
 * Stops the bursty “dump then silence” pattern that makes Live audio choppy.
 */
export class PacedDownlinkStreamer {
  private buffer = Buffer.alloc(0);
  private sampleRate = 24_000;
  private epoch = 1;
  private seq = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly send: (frame: Buffer) => void;

  constructor(send: (frame: Buffer) => void) {
    this.send = send;
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
    if (pcm.length === 0 || pcm.length % 2 !== 0) return;
    if (sampleRate > 0) this.sampleRate = sampleRate;
    this.buffer = this.buffer.length === 0 ? pcm : Buffer.concat([this.buffer, pcm]);
    this.ensureTimer();
  }

  /** Drain remaining audio as paced slices (or one last partial). */
  forceFlush() {
    const slice = sliceBytesForRate(this.sampleRate);
    while (this.buffer.length >= slice) {
      this.emitSlice(slice);
    }
    if (this.buffer.length >= 2) {
      const pcm = this.buffer;
      this.buffer = Buffer.alloc(0);
      this.emitRaw(pcm);
    } else {
      this.buffer = Buffer.alloc(0);
    }
    this.stopTimer();
  }

  reset() {
    this.stopTimer();
    this.buffer = Buffer.alloc(0);
  }

  private ensureTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), DOWNLINK_TICK_MS);
    // Don't let the timer keep the process alive alone.
    if (typeof this.timer === "object" && this.timer && "unref" in this.timer) {
      (this.timer as NodeJS.Timeout).unref?.();
    }
  }

  private stopTimer() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private tick() {
    const slice = sliceBytesForRate(this.sampleRate);
    if (this.buffer.length < slice) {
      // Wait for more Gemini audio; keep timer while a reply may still be streaming.
      return;
    }
    // Exactly one realtime slice per tick — smooth WS cadence.
    this.emitSlice(slice);
  }

  private emitSlice(slice: number) {
    const pcm = this.buffer.subarray(0, slice);
    this.buffer = this.buffer.subarray(slice);
    this.emitRaw(pcm);
  }

  private emitRaw(pcm: Buffer) {
    const seq = this.seq;
    this.seq = (this.seq + 1) >>> 0;
    this.send(encodePcmFrame(AUDIO_KIND_DOWNLINK, this.epoch, this.sampleRate, seq, pcm));
  }
}

/** @deprecated Alias — Live sessions use paced streaming. */
export class DownlinkAudioBatcher extends PacedDownlinkStreamer {}
