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
 * base64 overhead and let the proxy coalesce cleanly.
 */

export const AUDIO_PROTOCOL = "wp1";
export const AUDIO_KIND_DOWNLINK = 1;
export const AUDIO_KIND_UPLINK = 2;

const MAGIC0 = 0x57; // W
const MAGIC1 = 0x50; // P
const VERSION = 1;
const HEADER_BYTES = 16;

/** Target ~160ms at 24 kHz s16le before flushing a downlink frame. */
export const DOWNLINK_TARGET_BYTES = 7680;
/** Flush partial batch if idle this long (ms). */
export const DOWNLINK_MAX_HOLD_MS = 60;

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

/** Coalesce tiny Gemini PCM fragments into steadier downlink frames. */
export class DownlinkAudioBatcher {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private sampleRate = 24_000;
  private epoch = 1;
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly flush: (frame: Buffer) => void;

  constructor(flush: (frame: Buffer) => void) {
    this.flush = flush;
  }

  /** Drop pending audio and advance epoch — used on barge/interrupt (never flush stale PCM). */
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
    this.chunks.push(pcm);
    this.bytes += pcm.length;
    if (this.bytes >= DOWNLINK_TARGET_BYTES) {
      this.forceFlush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.forceFlush();
      }, DOWNLINK_MAX_HOLD_MS);
    }
  }

  forceFlush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.bytes === 0) return;
    const pcm = Buffer.concat(this.chunks, this.bytes);
    this.chunks = [];
    this.bytes = 0;
    const seq = this.seq;
    this.seq = (this.seq + 1) >>> 0;
    this.flush(encodePcmFrame(AUDIO_KIND_DOWNLINK, this.epoch, this.sampleRate, seq, pcm));
  }

  reset() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.chunks = [];
    this.bytes = 0;
  }
}
