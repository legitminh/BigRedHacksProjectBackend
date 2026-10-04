import assert from "node:assert/strict";
import test, { mock } from "node:test";

import {
  AUDIO_KIND_DOWNLINK,
  AUDIO_KIND_UPLINK,
  DOWNLINK_SLICE_BYTES_24K,
  DOWNLINK_TICK_MS,
  DownlinkAudioBatcher,
  encodePcmFrame,
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

test("paced streamer emits one ~20ms slice per tick", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const frames: Buffer[] = [];
    const streamer = new PacedDownlinkStreamer((frame) => frames.push(frame));
    // 3 slices of 20ms @ 24kHz s16le
    const pcm = Buffer.alloc(DOWNLINK_SLICE_BYTES_24K * 3, 1);
    streamer.push(pcm.toString("base64"), 24_000);
    assert.equal(frames.length, 0, "must not dump immediately");

    mock.timers.tick(DOWNLINK_TICK_MS);
    assert.equal(frames.length, 1);
    let decoded = tryDecodePcmFrame(frames[0]);
    assert.ok(decoded);
    assert.equal(decoded.pcm.length, DOWNLINK_SLICE_BYTES_24K);
    assert.equal(decoded.seq, 0);

    mock.timers.tick(DOWNLINK_TICK_MS);
    assert.equal(frames.length, 2);
    decoded = tryDecodePcmFrame(frames[1]);
    assert.equal(decoded?.seq, 1);

    mock.timers.tick(DOWNLINK_TICK_MS);
    assert.equal(frames.length, 3);
    decoded = tryDecodePcmFrame(frames[2]);
    assert.equal(decoded?.seq, 2);
    assert.equal(decoded?.kind, AUDIO_KIND_DOWNLINK);

    mock.timers.tick(DOWNLINK_TICK_MS * 5);
    assert.equal(frames.length, 3, "no extra frames when buffer empty");
    streamer.reset();
  } finally {
    mock.timers.reset();
  }
});

test("forceFlush drains remainder then stops timer", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const frames: Buffer[] = [];
    const streamer = new PacedDownlinkStreamer((frame) => frames.push(frame));
    const pcm = Buffer.alloc(DOWNLINK_SLICE_BYTES_24K + 100, 2);
    streamer.push(pcm.toString("base64"), 24_000);
    streamer.forceFlush();
    assert.equal(frames.length, 2);
    assert.equal(tryDecodePcmFrame(frames[0])?.pcm.length, DOWNLINK_SLICE_BYTES_24K);
    assert.equal(tryDecodePcmFrame(frames[1])?.pcm.length, 100);
    mock.timers.tick(DOWNLINK_TICK_MS * 3);
    assert.equal(frames.length, 2);
  } finally {
    mock.timers.reset();
  }
});

test("setEpoch drops buffered audio and resets seq", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const frames: Buffer[] = [];
    const streamer = new PacedDownlinkStreamer((frame) => frames.push(frame));
    streamer.push(Buffer.alloc(DOWNLINK_SLICE_BYTES_24K * 2, 3).toString("base64"), 24_000);
    mock.timers.tick(DOWNLINK_TICK_MS);
    assert.equal(frames.length, 1);
    streamer.setEpoch(7);
    mock.timers.tick(DOWNLINK_TICK_MS * 3);
    assert.equal(frames.length, 1, "buffered audio discarded on epoch bump");
    streamer.push(Buffer.alloc(DOWNLINK_SLICE_BYTES_24K, 4).toString("base64"), 24_000);
    mock.timers.tick(DOWNLINK_TICK_MS);
    assert.equal(frames.length, 2);
    const decoded = tryDecodePcmFrame(frames[1]);
    assert.equal(decoded?.epoch, 7);
    assert.equal(decoded?.seq, 0);
    streamer.reset();
  } finally {
    mock.timers.reset();
  }
});

test("DownlinkAudioBatcher alias still paces", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const frames: Buffer[] = [];
    const batcher = new DownlinkAudioBatcher((frame) => frames.push(frame));
    batcher.push(Buffer.alloc(DOWNLINK_SLICE_BYTES_24K, 5).toString("base64"), 24_000);
    assert.equal(frames.length, 0);
    mock.timers.tick(DOWNLINK_TICK_MS);
    assert.equal(frames.length, 1);
    batcher.reset();
  } finally {
    mock.timers.reset();
  }
});
test("uplink kind is distinct", () => {
  const frame = encodePcmFrame(AUDIO_KIND_UPLINK, 1, 16000, 0, Buffer.alloc(4));
  const decoded = tryDecodePcmFrame(frame);
  assert.equal(decoded?.kind, AUDIO_KIND_UPLINK);
});
