import assert from "node:assert/strict";
import { test } from "node:test";

import { loadConfig, type Config } from "../src/config.ts";
import { HttpError } from "../src/http.ts";
import {
  buildConceptMapPrompt,
  generateConceptMap,
  parseConceptMapBody,
  parseImagineResponse,
} from "../src/imagine/conceptMap.ts";

const JPEG = "/9j/" + "A".repeat(40);

function config(extra: Record<string, string> = {}): Config {
  return loadConfig({
    GOOGLE_CLIENT_ID: "client-id.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "client-secret",
    SESSION_SECRET: "0123456789abcdef0123456789abcdef",
    PUBLIC_BASE_URL: "http://127.0.0.1:8787",
    ...extra,
  });
}

const BLANK_DIGLOG = `# Finish ENGL 1140 work

## What I worked on
Not captured.

## Decisions
Not captured.

## Stuck on
Not captured.

## Next
Not captured.`;

test("brag sheet prompt uses space mission stats and drops a study suggestion", () => {
  const prompt = buildConceptMapPrompt(
    "## Heaps\n\nPush is O(log n).\n<<<STUDY_SUGGEST>>>{\"goals\":\"flashcards\"}<<<END_STUDY_SUGGEST>>>",
    { locked_in_minutes: 25, mission: "Heaps practice" },
  );
  assert.match(prompt, /brag sheet/i);
  assert.match(prompt, /NOT a concept map/i);
  assert.match(prompt, /NOT a flowchart/i);
  assert.match(prompt, /Locked in: 25 minutes/);
  assert.match(prompt, /Mission: Heaps practice/);
  assert.match(prompt, /Push is O\(log n\)/);
  const stats = prompt.split("BRAG SHEET STATS:\n")[1] ?? "";
  assert.doesNotMatch(stats, /Not captured/i);
  assert.doesNotMatch(prompt, /STUDY_SUGGEST/);
  assert.doesNotMatch(prompt, /flashcards/);
});

test("session summary rejects an empty note and an image payload", () => {
  assert.throws(
    () => parseConceptMapBody({ markdown: "   " }),
    (error: unknown) => error instanceof HttpError && error.code === "invalid_concept_map",
  );
  assert.throws(
    () => parseConceptMapBody({ markdown: "Heaps", screenshot: "abc" }),
    (error: unknown) => error instanceof HttpError && error.code === "image_not_allowed",
  );
});

test("empty diglog with mission title is allowed for a time+mission brag sheet", () => {
  const parsed = parseConceptMapBody({
    markdown: BLANK_DIGLOG,
    locked_in_minutes: 40,
  });
  assert.equal(parsed.stats.locked_in_minutes, 40);
  const prompt = buildConceptMapPrompt(parsed.markdown, parsed.stats);
  assert.match(prompt, /Locked in: 40 minutes/);
  assert.match(prompt, /Mission: Finish ENGL 1140 work/);
  const stats = prompt.split("BRAG SHEET STATS:\n")[1] ?? "";
  assert.doesNotMatch(stats, /Not captured/i);
  assert.doesNotMatch(stats, /What I worked on/i);
});

test("empty diglog with only a mission title (no duration) is still allowed", () => {
  const parsed = parseConceptMapBody({ markdown: BLANK_DIGLOG });
  const prompt = buildConceptMapPrompt(parsed.markdown, parsed.stats);
  assert.match(prompt, /Mission: Finish ENGL 1140 work/);
  const stats = prompt.split("BRAG SHEET STATS:\n")[1] ?? "";
  assert.doesNotMatch(stats, /Not captured/i);
});

test("truly empty body with no mission and no duration is refused", () => {
  assert.throws(
    () =>
      parseConceptMapBody({
        markdown: `## What I worked on
Not captured.

## Next
Not captured.`,
      }),
    (error: unknown) =>
      error instanceof HttpError &&
      error.code === "empty_concept_map" &&
      /locked-in time or a mission goal/i.test(error.message),
  );
});

test("brag sheet payload clips to 8000 characters", () => {
  const note = "a".repeat(9000);
  const prompt = buildConceptMapPrompt(note);
  const statsBlock = prompt.split("BRAG SHEET STATS:\n")[1] ?? "";
  assert.ok(statsBlock.length <= 8000);
  assert.match(prompt, /BRAG SHEET STATS:/);
});

test("imagine response keeps jpeg bytes and drops a data-url prefix", () => {
  const parsed = parseImagineResponse({
    data: [{ b64_json: `data:image/jpeg;base64,${JPEG}` }],
  });
  assert.equal(parsed.content_type, "image/jpeg");
  assert.equal(parsed.image_base64, JPEG);
});

test("session summary calls Grok Imagine with the brag prompt and returns the image", async () => {
  let body = "";
  const image = await generateConceptMap({
    config: config({ XAI_API_KEY: "xai-test-key" }),
    markdown: BLANK_DIGLOG,
    stats: { locked_in_minutes: 45, mission: "Finish ENGL 1140 work", on_task_percent: 80 },
    fetchImpl: async (_url, init) => {
      body = String(init?.body ?? "");
      return new Response(JSON.stringify({ data: [{ b64_json: JPEG }] }), { status: 200 });
    },
  });
  const sent = JSON.parse(body) as {
    model: string;
    prompt: string;
    n: number;
    aspect_ratio: string;
    resolution: string;
    quality: string;
    response_format: string;
  };
  assert.equal(sent.model, "grok-imagine-image-2.0");
  assert.equal(sent.n, 1);
  assert.equal(sent.aspect_ratio, "16:9");
  assert.equal(sent.resolution, "1k");
  assert.equal(sent.quality, "low");
  assert.equal(sent.response_format, "b64_json");
  assert.match(sent.prompt, /Locked in: 45 minutes/);
  assert.match(sent.prompt, /space-mission brag sheet/i);
  const stats = sent.prompt.split("BRAG SHEET STATS:\n")[1] ?? "";
  assert.doesNotMatch(stats, /Not captured/i);
  assert.equal(image.image_base64, JPEG);
});

test("session summary reports when Grok Imagine is not configured", async () => {
  await assert.rejects(
    () =>
      generateConceptMap({
        config: config(),
        markdown: "Heaps",
        fetchImpl: async () => {
          throw new Error("fetch should not run");
        },
      }),
    (error: unknown) =>
      error instanceof HttpError &&
      error.code === "imagine_not_configured" &&
      /Brag sheets need Grok Imagine/i.test(error.message),
  );
});
