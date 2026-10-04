import assert from "node:assert/strict";
import test from "node:test";

import { geminiChat } from "../src/gemini/chat.ts";
import { HttpError } from "../src/http.ts";

const base = { apiKey: "k", model: "gemini-3.8-flash", system: "sys", history: [], message: "hi" };
const json = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

test("geminiChat posts generateContent for the requested model and returns text", async () => {
  let url = "";
  let body: { contents: Array<{ role: string }>; systemInstruction: unknown } | null = null;
  const reply = await geminiChat({
    ...base,
    history: [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ],
    fetchImpl: (async (u: string, init: RequestInit) => {
      url = u;
      body = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: " Do Chem. " }] } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch,
  });
  assert.equal(reply, "Do Chem.");
  assert.match(url, /models\/gemini-3\.8-flash:generateContent/);
  assert.deepEqual(body!.contents.map((c) => c.role), ["user", "model", "user"]);
});

test("geminiChat maps real quota errors to gemini_quota", async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(
      () => geminiChat({ ...base, fetchImpl: json(429, { error: { message: "x", status: "RESOURCE_EXHAUSTED" } }) }),
      (e: unknown) => e instanceof HttpError && e.code === "gemini_quota" && e.status === 429,
    );
  } finally {
    console.warn = warn;
  }
});

test("geminiChat: non-quota failures stay gemini_failed; empty is gemini_empty", async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(
      () => geminiChat({ ...base, fetchImpl: json(404, { error: { message: "model not found", status: "NOT_FOUND" } }) }),
      (e: unknown) =>
        e instanceof HttpError &&
        e.code === "gemini_failed" &&
        !/model not found/i.test(e.message),
    );
    await assert.rejects(
      () => geminiChat({ ...base, fetchImpl: json(200, { candidates: [] }) }),
      (e: unknown) => e instanceof HttpError && e.code === "gemini_empty",
    );
  } finally {
    console.warn = warn;
  }
});
