import assert from "node:assert/strict";
import test, { mock } from "node:test";

import {
  AUDIO_KIND_DOWNLINK,
  AUDIO_KIND_UPLINK,
  DOWNLINK_SLICE_BYTES_24K,
  DOWNLINK_TICK_MS,
  DownlinkAudioBatcher,
  encodePcmFrame,
  LiveDownlink,
  PacedDownlinkStreamer,
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

test("LiveDownlink forwards complete slices immediately", () => {
  const frames: Buffer[] = [];
  const streamer = new LiveDownlink((frame) => frames.push(frame));
  streamer.push(Buffer.alloc(DOWNLINK_SLICE_BYTES_24K * 3, 1).toString("base64"), 24_000);
  assert.equal(frames.length, 3);
  assert.equal(tryDecodePcmFrame(frames[0])?.seq, 0);
  assert.equal(tryDecodePcmFrame(frames[2])?.seq, 2);
  streamer.reset();
});

test("partial slice is held until more bytes arrive", () => {
  const frames: Buffer[] = [];
  const streamer = new LiveDownlink((frame) => frames.push(frame));
  streamer.push(Buffer.alloc(100, 1).toString("base64"), 24_000);
  assert.equal(frames.length, 0);
  streamer.push(Buffer.alloc(DOWNLINK_SLICE_BYTES_24K, 2).toString("base64"), 24_000);
  assert.equal(frames.length, 1);
  streamer.reset();
});

test("odd-length Gemini chunks are stitched, not dropped", () => {
  const frames: Buffer[] = [];
  const streamer = new LiveDownlink((frame) => frames.push(frame));
  streamer.push(Buffer.alloc(961, 1).toString("base64"), 24_000);
  assert.equal(frames.length, 1);
  streamer.push(Buffer.alloc(959, 2).toString("base64"), 24_000);
  assert.equal(frames.length, 2);
  assert.equal(Math.round(streamer.sentMs()), 40);
  streamer.reset();
});

test("endStream flushes the tail and reports drained", () => {
  const frames: Buffer[] = [];
  const streamer = new LiveDownlink((frame) => frames.push(frame));
  streamer.push(Buffer.alloc(DOWNLINK_SLICE_BYTES_24K * 5 + 100, 1).toString("base64"), 24_000);
  assert.equal(frames.length, 5);
  let drained = false;
  streamer.endStream(() => {
    drained = true;
  });
  assert.equal(drained, true);
  assert.equal(frames.length, 6);
  assert.equal(tryDecodePcmFrame(frames[5])?.pcm.length, 100);
});

test("setEpoch cancels a pending drain under backpressure", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    let drained = 0;
    const streamer = new LiveDownlink(() => {}, { ready: () => false });
    streamer.push(Buffer.alloc(DOWNLINK_SLICE_BYTES_24K, 1).toString("base64"), 24_000);
    streamer.endStream(() => {
      drained += 1;
    });
    assert.equal(drained, 0);
    streamer.setEpoch(2);
    mock.timers.tick(DOWNLINK_TICK_MS * 5);
    assert.equal(drained, 0);
  } finally {
    mock.timers.reset();
  }
});

test("backpressure holds audio and never drops samples", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const frames: Buffer[] = [];
    let open = false;
    const streamer = new LiveDownlink((frame) => frames.push(frame), {
      ready: () => open,
    });
    streamer.push(Buffer.alloc(DOWNLINK_SLICE_BYTES_24K * 3, 1).toString("base64"), 24_000);
    assert.equal(frames.length, 0);
    assert.equal(Math.round(streamer.bufferedMs()), 60);
    open = true;
    mock.timers.tick(DOWNLINK_TICK_MS);
    assert.equal(frames.length, 3);
    streamer.reset();
  } finally {
    mock.timers.reset();
  }
});

test("setEpoch drops buffered audio and resets seq", () => {
  const frames: Buffer[] = [];
  const streamer = new LiveDownlink((frame) => frames.push(frame));
  streamer.push(Buffer.alloc(DOWNLINK_SLICE_BYTES_24K, 1).toString("base64"), 24_000);
  streamer.setEpoch(9);
  streamer.push(Buffer.alloc(DOWNLINK_SLICE_BYTES_24K, 3).toString("base64"), 24_000);
  assert.equal(tryDecodePcmFrame(frames[1])?.epoch, 9);
  assert.equal(tryDecodePcmFrame(frames[1])?.seq, 0);
  streamer.reset();
});

test("aliases still construct", () => {
  const frames: Buffer[] = [];
  const a = new PacedDownlinkStreamer((f) => frames.push(f));
  const b = new DownlinkAudioBatcher((f) => frames.push(f));
  a.push(Buffer.alloc(DOWNLINK_SLICE_BYTES_24K, 1).toString("base64"), 24_000);
  b.push(Buffer.alloc(DOWNLINK_SLICE_BYTES_24K, 1).toString("base64"), 24_000);
  assert.equal(frames.length, 2);
  a.reset();
  b.reset();
});

test("uplink kind is distinct", () => {
  const frame = encodePcmFrame(AUDIO_KIND_UPLINK, 1, 16000, 0, Buffer.alloc(4));
  assert.equal(tryDecodePcmFrame(frame)?.kind, AUDIO_KIND_UPLINK);
});
