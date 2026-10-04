import assert from "node:assert/strict";
import test from "node:test";

import {
  GROK_TTS_MAX_CHARS,
  grokTtsStreamUrl,
  parseGrokEvent,
  textClear,
  textDelta,
  textDone,
} from "../src/companion/grokTts.ts";
import { SpeechQueue } from "../src/companion/speechQueue.ts";
import {
  chunkForTts,
  clipForTts,
} from "../src/companion/liveSession.ts";
import {
  buildCompanionListenSystem,
  buildCopilotChatSystem,
  GOOGLE_CONTEXT_RULES,
  LISTEN_ONLY_LIVE_SYSTEM,
  selectGeminiChatModel,
  VOICE_REPLY_SYSTEM,
} from "../src/companion/geminiLive.ts";
import { loadConfig } from "../src/config.ts";

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

test("chunkForTts splits long replies without ellipsis truncation", () => {
  const sentenceA =
    "First sentence about the homework due Friday, the PDF to open next, and the pages you should skim before class.";
  const sentenceB =
    "Second sentence covers the syllabus grading section, office hours, and the calendar conflicts that show up tomorrow afternoon.";
  const sentenceC =
    "Third sentence wraps a concrete plan so you can start the next focused block without rereading the whole drive dump.";
  const sentenceD =
    "Fourth sentence adds one more reminder about submitting early so the spoken reply clearly exceeds the free-tier TTS budget.";
  const long = `${sentenceA} ${sentenceB} ${sentenceC} ${sentenceD}`;
  assert.ok(long.length > GROK_TTS_MAX_CHARS);

  const clipped = clipForTts(long);
  assert.ok(clipped.endsWith("…"));
  assert.ok(clipped.length <= GROK_TTS_MAX_CHARS);

  const chunks = chunkForTts(long);
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= GROK_TTS_MAX_CHARS);
    assert.equal(chunk.includes("…"), false);
  }
  assert.equal(chunks.join(" "), long.replace(/\s+/g, " ").trim());
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

test("speech queue speakUtterances plays chunks in order", () => {
  const queue = new SpeechQueue();
  const start = queue.speakUtterances(["chunk one.", "chunk two.", "chunk three."]);
  assert.equal(start.length, 2);
  assert.match((start[0] as { message: string }).message, /chunk one/);
  assert.match((start[1] as { message: string }).message, /text\.done/);
  assert.ok(queue.isBusy());

  const mid = queue.onGrok({ kind: "done" });
  assert.equal(mid.some((a) => a.type === "ended"), false);
  assert.equal(mid.length, 2);
  assert.match((mid[0] as { message: string }).message, /chunk two/);
  assert.match((mid[1] as { message: string }).message, /text\.done/);

  const lastStart = queue.onGrok({ kind: "done" });
  assert.match((lastStart[0] as { message: string }).message, /chunk three/);
  const ended = queue.onGrok({ kind: "done" });
  assert.equal(ended[0]?.type, "ended");
  assert.equal(queue.isBusy(), false);
});

test("speech queue cancel clears remaining utterance chunks", () => {
  const queue = new SpeechQueue();
  queue.speakUtterances(["keep going one.", "keep going two.", "keep going three."]);
  const cleared = queue.cancel();
  assert.ok(cleared.some((a) => a.type === "cleared"));
  assert.equal(queue.isBusy(), true); // discard until audio.clear
  // Nothing left to flush after clear — pending was wiped.
  const resumed = queue.onGrok({ kind: "cleared" });
  assert.equal(resumed.length, 0);
  assert.equal(queue.isBusy(), false);
  // A fresh speak after cancel works.
  const next = queue.speakUtterances(["fresh reply."]);
  assert.equal(next.length, 2);
  assert.match((next[0] as { message: string }).message, /fresh reply/);
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
  assert.match(VOICE_REPLY_SYSTEM, /1–3 short sentences|1-3 short/i);
  assert.match(VOICE_REPLY_SYSTEM, /STRUCTURED LIST|LITE DEPTH/i);
  assert.match(VOICE_REPLY_SYSTEM, /MUST enumerate EVERY non-retired matching row/i);
  assert.match(VOICE_REPLY_SYSTEM, /identifying fields and counts|identifying fields \+ counts/i);
  assert.match(VOICE_REPLY_SYSTEM, /FORBID 1–2 sentence category summaries|FORBID 1-2 sentence category/i);
  assert.match(VOICE_REPLY_SYSTEM, /first inventory/i);
  assert.match(VOICE_REPLY_SYSTEM, /Chat UI and spoken answer both cover/i);
  assert.match(VOICE_REPLY_SYSTEM, /Never promise to pull/i);
  assert.match(VOICE_REPLY_SYSTEM, /cannot access Google Drive|Re-link Calendar/i);
  assert.match(GOOGLE_CONTEXT_RULES, /MUST enumerate EVERY non-retired row/i);
  assert.match(GOOGLE_CONTEXT_RULES, /FORBID 1–2 sentence category summaries|FORBID 1-2 sentence category/i);
  assert.match(
    buildCopilotChatSystem("=== DEEP BRIEF ===\nSTRUCTURED LIST (complete, 2 items):\nrow"),
    /MUST enumerate EVERY non-retired matching row|FORBID 1–2 sentence category/i,
  );
  const cfg = loadConfig({
    GEMINI_MODEL: "gemini-3.5-flash-lite",
    GEMINI_OVERVIEW_MODEL: "gemini-3.5-flash",
  });
  assert.equal(
    selectGeminiChatModel(cfg, { system: "plain", message: "hi" }),
    "gemini-3.5-flash-lite",
  );
  assert.equal(
    selectGeminiChatModel(cfg, {
      system: "=== DEEP BRIEF ===",
      message: "ok",
    }),
    "gemini-3.5-flash-lite",
  );
  assert.equal(
    selectGeminiChatModel(cfg, {
      system: "x",
      message: "List all climbing gear excluding retired",
    }),
    "gemini-3.5-flash-lite",
  );
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
