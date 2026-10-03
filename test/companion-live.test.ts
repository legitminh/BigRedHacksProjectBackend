import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCompanionSystem,
  sampleRateFromMime,
  setupMessage,
  signalsFromMessage,
} from "../src/companion/geminiLive.ts";

test("setup requests audio + transcripts like the Live demo", () => {
  const setup = setupMessage("gemini-3.8-live", "You are a study companion.") as {
    setup: {
      model: string;
      generationConfig: { responseModalities: string[] };
      inputAudioTranscription: unknown;
      outputAudioTranscription: unknown;
    };
  };
  assert.equal(setup.setup.model, "models/gemini-3.8-live");
  assert.equal(setup.setup.generationConfig.responseModalities[0], "AUDIO");
  assert.ok(setup.setup.inputAudioTranscription);
  assert.ok(setup.setup.outputAudioTranscription);
});

test("parses transcript and completion signals", () => {
  const signals = signalsFromMessage({
    serverContent: {
      outputTranscription: { text: "Hello there." },
      generationComplete: true,
    },
  });
  assert.deepEqual(
    signals.map((s) => s.kind),
    ["assistant_fragment", "generation_complete"],
  );
});

test("study context lands in companion system prompt", () => {
  const system = buildCompanionSystem({
    goals: "CS 2110 heaps",
    remaining_mins: 12,
    notes: "binary heap insert",
  });
  assert.match(system, /Waypoint Companion/);
  assert.match(system, /CS 2110 heaps/);
  assert.match(system, /binary heap insert/);
});

test("sample rate parses from mime", () => {
  assert.equal(sampleRateFromMime("audio/pcm;rate=24000"), 24000);
  assert.equal(sampleRateFromMime("audio/pcm"), 24000);
});
