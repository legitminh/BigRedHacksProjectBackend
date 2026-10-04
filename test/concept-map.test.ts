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

test("concept map prompt uses the note and drops a study suggestion", () => {
  const prompt = buildConceptMapPrompt(
    "## Heaps\n\nPush is O(log n).\n<<<STUDY_SUGGEST>>>{\"goals\":\"flashcards\"}<<<END_STUDY_SUGGEST>>>",
  );
  assert.match(prompt, /concept map/);
  assert.match(prompt, /Push is O\(log n\)/);
  assert.doesNotMatch(prompt, /STUDY_SUGGEST/);
  assert.doesNotMatch(prompt, /flashcards/);
});

test("concept map rejects an empty note and an image payload", () => {
  assert.throws(
    () => parseConceptMapBody({ markdown: "   " }),
    (error: unknown) => error instanceof HttpError && error.code === "invalid_concept_map",
  );
  assert.throws(
    () => parseConceptMapBody({ markdown: "Heaps", screenshot: "abc" }),
    (error: unknown) => error instanceof HttpError && error.code === "image_not_allowed",
  );
});

test("concept map clips a long note to 8000 characters", () => {
  const note = "a".repeat(9000);
  const prompt = buildConceptMapPrompt(note);
  const source = prompt.split("NOTE:\n")[1] ?? "";
  assert.equal(source.length, 8000);
});

test("imagine response keeps jpeg bytes and drops a data-url prefix", () => {
  const parsed = parseImagineResponse({
    data: [{ b64_json: `data:image/jpeg;base64,${JPEG}` }],
  });
  assert.equal(parsed.content_type, "image/jpeg");
  assert.equal(parsed.image_base64, JPEG);
});

test("concept map calls Grok Imagine with the note and returns the image", async () => {
  let body = "";
  const image = await generateConceptMap({
    config: config({ XAI_API_KEY: "xai-test-key" }),
    markdown: "Priority queues use a heap.",
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
  assert.match(sent.prompt, /Priority queues use a heap/);
  assert.equal(image.image_base64, JPEG);
});

test("concept map reports when Grok Imagine is not configured", async () => {
  await assert.rejects(
    () =>
      generateConceptMap({
        config: config(),
        markdown: "Heaps",
        fetchImpl: async () => {
          throw new Error("fetch should not run");
        },
      }),
    (error: unknown) => error instanceof HttpError && error.code === "imagine_not_configured",
  );
});
