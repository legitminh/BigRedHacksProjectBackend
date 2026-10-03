import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCompanionSystem,
  sampleRateFromMime,
  screencapToolResponse,
  SCREENCAP_TOOL,
  setupMessage,
  signalsFromMessage,
  toolCallsFromMessage,
} from "../src/companion/geminiLive.ts";

test("setup requests audio + transcripts like the Live demo", () => {
  const setup = setupMessage("gemini-3.8-live", "You are a study companion.") as {
    setup: {
      model: string;
      generationConfig: { responseModalities: string[] };
      inputAudioTranscription: unknown;
      outputAudioTranscription: unknown;
      tools: { functionDeclarations: { name: string }[] }[];
    };
  };
  assert.equal(setup.setup.model, "models/gemini-3.8-live");
  assert.equal(setup.setup.generationConfig.responseModalities[0], "AUDIO");
  assert.ok(setup.setup.inputAudioTranscription);
  assert.ok(setup.setup.outputAudioTranscription);
  assert.equal(setup.setup.tools[0]?.functionDeclarations[0]?.name, SCREENCAP_TOOL);
});

test("parses request_screencap tool calls", () => {
  const calls = toolCallsFromMessage({
    toolCall: {
      functionCalls: [{ id: "call-1", name: SCREENCAP_TOOL }],
    },
  });
  assert.deepEqual(calls, [{ id: "call-1", name: SCREENCAP_TOOL }]);
});

test("screencap tool response includes jpeg clientContent", () => {
  const messages = screencapToolResponse(
    { id: "call-1", name: SCREENCAP_TOOL },
    "abc123",
    true,
  ) as Array<Record<string, unknown>>;
  assert.equal(messages.length, 2);
  const tool = messages[0].toolResponse as {
    functionResponses: { response: { ok: boolean } }[];
  };
  assert.equal(tool.functionResponses[0].response.ok, true);
  const content = messages[1].clientContent as {
    turns: { parts: { inlineData?: { mimeType: string; data: string } }[] }[];
  };
  assert.equal(content.turns[0].parts[1].inlineData?.mimeType, "image/jpeg");
  assert.equal(content.turns[0].parts[1].inlineData?.data, "abc123");
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
