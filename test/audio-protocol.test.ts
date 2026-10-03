import assert from "node:assert/strict";
import test from "node:test";

import {
  AUDIO_KIND_DOWNLINK,
  AUDIO_KIND_UPLINK,
  DownlinkAudioBatcher,
  DOWNLINK_TARGET_BYTES,
  encodePcmFrame,
  tryDecodePcmFrame,
} from "../src/companion/audioProtocol.ts";

test("wp1 encode/decode round-trips PCM", () => {
  const pcm = Buffer.alloc(8, 0x11);
  const frame = encodePcmFrame(AUDIO_KIND_DOWNLINK, 3, 24000, 9, pcm);
  const decoded = tryDecodePcmFrame(frame);
  assert.ok(decoded);
  assert.equal(decoded.kind, AUDIO_KIND_DOWNLINK);
  assert.equal(decoded.epoch, 3);
  assert.equal(decoded.sampleRate, 24000);
  assert.equal(decoded.seq, 9);
  assert.deepEqual(decoded.pcm, pcm);
});

test("batcher coalesces until target then flushes", async () => {
  const frames: Buffer[] = [];
  const batcher = new DownlinkAudioBatcher((frame) => frames.push(frame));
  const chunk = Buffer.alloc(400, 1);
  const b64 = chunk.toString("base64");
  // Push until over target
  const need = Math.ceil(DOWNLINK_TARGET_BYTES / chunk.length);
  for (let i = 0; i < need; i += 1) batcher.push(b64, 24000);
  assert.ok(frames.length >= 1);
  const decoded = tryDecodePcmFrame(frames[0]);
  assert.ok(decoded);
  assert.equal(decoded.kind, AUDIO_KIND_DOWNLINK);
  assert.ok(decoded.pcm.length >= DOWNLINK_TARGET_BYTES);
});

test("uplink kind is distinct", () => {
  const frame = encodePcmFrame(AUDIO_KIND_UPLINK, 1, 16000, 0, Buffer.alloc(4));
  const decoded = tryDecodePcmFrame(frame);
  assert.equal(decoded?.kind, AUDIO_KIND_UPLINK);
});
