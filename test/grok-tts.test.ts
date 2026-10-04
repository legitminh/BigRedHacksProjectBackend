import assert from "node:assert/strict";
import test from "node:test";

import {
  grokTtsStreamUrl,
  parseGrokEvent,
  textClear,
  textDelta,
  textDone,
} from "../src/companion/grokTts.ts";
import { SpeechQueue } from "../src/companion/speechQueue.ts";
import {
  buildCompanionListenSystem,
  LISTEN_ONLY_LIVE_SYSTEM,
  VOICE_REPLY_SYSTEM,
} from "../src/companion/geminiLive.ts";

test("grok stream url uses pcm 24kHz", () => {
  const url = grokTtsStreamUrl("eve", "en");
  assert.match(url, /voice=eve/);
  assert.match(url, /codec=pcm/);
  assert.match(url, /sample_rate=24000/);
  assert.throws(() => grokTtsStreamUrl("eve&x", "en"));
});

test("parses grok audio and control events", () => {
  const encoded = Buffer.from([0, 1, 2, 3]).toString("base64");
  const audio = parseGrokEvent(JSON.stringify({ type: "audio.delta", delta: encoded }));
  assert.equal(audio.kind, "audio");
  if (audio.kind === "audio") assert.deepEqual([...audio.bytes], [0, 1, 2, 3]);
  assert.equal(parseGrokEvent(JSON.stringify({ type: "audio.done" })).kind, "done");
  assert.equal(parseGrokEvent(JSON.stringify({ type: "audio.clear" })).kind, "cleared");
  assert.equal(
    parseGrokEvent(JSON.stringify({ type: "error", message: "nope" })).kind,
    "error",
  );
});

test("client messages match streaming protocol", () => {
  assert.match(textDelta("Hi"), /text\.delta/);
  assert.match(textDone(), /text\.done/);
  assert.match(textClear(), /text\.clear/);
});

test("speech queue speak then finish", () => {
  const queue = new SpeechQueue();
  const speak = queue.speak("Hello");
  assert.equal(speak.length, 1);
  assert.equal(speak[0]?.type, "send");
  assert.equal(queue.finish()[0]?.type, "send");
  assert.ok(queue.isBusy());
  const audio = queue.onGrok({ kind: "audio", bytes: Buffer.from([9, 9]) });
  assert.equal(audio[0]?.type, "audio");
  assert.ok(queue.notePlayback(1));
  assert.equal(queue.notePlayback(1), false);
  const ended = queue.onGrok({ kind: "done" });
  assert.equal(ended[0]?.type, "ended");
  assert.equal(queue.isBusy(), false);
});

test("speech queue cancel drops inflight and plays next after clear", () => {
  const queue = new SpeechQueue();
  queue.speak("old reply");
  const cleared = queue.cancel();
  assert.ok(cleared.some((a) => a.type === "cleared" && a.epoch === 2));
  assert.equal(queue.speak("new reply").length, 0);
  assert.equal(queue.onGrok({ kind: "audio", bytes: Buffer.from([1]) }).length, 0);
  const resumed = queue.onGrok({ kind: "cleared" });
  assert.equal(resumed[0]?.type, "send");
  assert.match((resumed[0] as { message: string }).message, /new reply/);
});

test("speech queue error clears awaiting so the next speak is not stuck", () => {
  const queue = new SpeechQueue();
  queue.speak("hi");
  queue.finish();
  assert.ok(queue.isBusy());
  const failed = queue.onGrok({ kind: "error", message: "boom" });
  assert.equal(failed[0]?.type, "failed");
  assert.equal(queue.isBusy(), false);
  const next = queue.speak("retry");
  assert.equal(next.length, 1);
  assert.equal(next[0]?.type, "send");
});

test("listen-only Live system stays silent and screen-free", () => {
  assert.match(LISTEN_ONLY_LIVE_SYSTEM, /silent|Do not speak/i);
  assert.doesNotMatch(LISTEN_ONLY_LIVE_SYSTEM, /request_screencap/i);
  assert.match(VOICE_REPLY_SYSTEM, /1–2 short spoken sentences|1-2 short/i);
  assert.match(VOICE_REPLY_SYSTEM, /cannot access Google Drive|Re-link Calendar/i);
  const system = buildCompanionListenSystem({ goals: "heaps" });
  assert.match(system, /silent|Do not speak/i);
  assert.match(system, /heaps/);
});

test("liveSession source discards Gemini PCM (cascade contract)", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../src/companion/liveSession.ts", import.meta.url), "utf8");
  assert.match(src, /signal\.kind === "audio"/);
  assert.match(src, /discard Gemini PCM|never forward Gemini/i);
  assert.doesNotMatch(src, /downlink\.push\([^)]*signal/);
});
