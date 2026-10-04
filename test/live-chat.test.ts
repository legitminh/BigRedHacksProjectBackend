import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { WebSocketServer } from "ws";

import { geminiLiveChat } from "../src/gemini/liveChat.ts";
import { HttpError } from "../src/http.ts";

test("geminiLiveChat opens an isolated AUDIO Live session and transcribes and returns the reply", async () => {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const port = (wss.address() as AddressInfo).port;

  let sawTextSetup = false;
  let sawClientContent = false;
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as {
        setup?: { generationConfig?: { responseModalities?: string[] }; tools?: unknown };
        clientContent?: { turns: { role: string; parts: { text: string }[] }[] };
      };
      if (msg.setup) {
        const setup = msg.setup as {
          generationConfig?: { responseModalities?: string[] };
          outputAudioTranscription?: unknown;
        };
        sawTextSetup =
          setup.generationConfig?.responseModalities?.join(",") === "AUDIO" &&
          setup.outputAudioTranscription !== undefined;
        assert.equal(msg.setup.tools, undefined);
        ws.send(JSON.stringify({ setupComplete: {} }));
        return;
      }
      if (msg.clientContent) {
        sawClientContent = true;
        assert.equal(msg.clientContent.turns.at(-1)?.parts[0]?.text, "What next?");
        ws.send(
          JSON.stringify({
            serverContent: {
              modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "AAAA" } }] },
              outputTranscription: { text: "Do the reading " },
            },
          }),
        );
        ws.send(JSON.stringify({ serverContent: { outputTranscription: { text: "for Chem." } } }));
        ws.send(JSON.stringify({ serverContent: { turnComplete: true } }));
      }
    });
  });

  const reply = await geminiLiveChat({
    apiKey: "test-key",
    model: "gemini-3.8-live",
    system: "You are Waypoint.",
    history: [{ role: "user", content: "hi" }],
    message: "What next?",
    url: `ws://127.0.0.1:${port}`,
    setupTimeoutMs: 2_000,
    replyTimeoutMs: 2_000,
  });

  assert.equal(reply, "Do the reading for Chem.");
  assert.equal(sawTextSetup, true);
  assert.equal(sawClientContent, true);
  await new Promise<void>((resolve) => wss.close(() => resolve()));
});

test("geminiLiveChat maps empty replies to gemini_empty", async () => {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const port = (wss.address() as AddressInfo).port;
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as { setup?: unknown; clientContent?: unknown };
      if (msg.setup) {
        ws.send(JSON.stringify({ setupComplete: {} }));
        return;
      }
      if (msg.clientContent) {
        ws.send(JSON.stringify({ serverContent: { turnComplete: true } }));
      }
    });
  });

  await assert.rejects(
    () =>
      geminiLiveChat({
        apiKey: "k",
        model: "m",
        system: "s",
        history: [],
        message: "hi",
        url: `ws://127.0.0.1:${port}`,
        setupTimeoutMs: 2_000,
        replyTimeoutMs: 2_000,
      }),
    (err: unknown) => err instanceof HttpError && err.code === "gemini_empty",
  );
  await new Promise<void>((resolve) => wss.close(() => resolve()));
});

test("two concurrent geminiLiveChat calls keep separate histories", async () => {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const port = (wss.address() as AddressInfo).port;
  const seen: string[] = [];

  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as {
        setup?: unknown;
        clientContent?: { turns: { parts: { text: string }[] }[] };
      };
      if (msg.setup) {
        ws.send(JSON.stringify({ setupComplete: {} }));
        return;
      }
      if (msg.clientContent) {
        const last = msg.clientContent.turns.at(-1)?.parts[0]?.text ?? "";
        seen.push(last);
        ws.send(
          JSON.stringify({
            serverContent: {
              modelTurn: { parts: [{ text: `echo:${last}` }] },
              turnComplete: true,
            },
          }),
        );
      }
    });
  });

  const [a, b] = await Promise.all([
    geminiLiveChat({
      apiKey: "k",
      model: "m",
      system: "user-a-system",
      history: [{ role: "user", content: "a-hist" }],
      message: "from-a",
      url: `ws://127.0.0.1:${port}`,
      setupTimeoutMs: 2_000,
      replyTimeoutMs: 2_000,
    }),
    geminiLiveChat({
      apiKey: "k",
      model: "m",
      system: "user-b-system",
      history: [{ role: "user", content: "b-hist" }],
      message: "from-b",
      url: `ws://127.0.0.1:${port}`,
      setupTimeoutMs: 2_000,
      replyTimeoutMs: 2_000,
    }),
  ]);

  assert.equal(a, "echo:from-a");
  assert.equal(b, "echo:from-b");
  assert.ok(seen.includes("from-a"));
  assert.ok(seen.includes("from-b"));
  await new Promise<void>((resolve) => wss.close(() => resolve()));
});

test("mapLiveError: modality/1007 is not quota; bare 429 digits are not quota", async () => {
  const { mapLiveError } = await import("../src/gemini/liveChat.ts");
  const warn = console.warn;
  console.warn = () => {};
  try {
    const modality = mapLiveError(
      new Error(
        "Gemini closed before a reply (1007: The requested combination of response modalities (TEXT) is not supported by the model. models/x429y)",
      ),
    );
    assert.equal(modality.code, "gemini_unsupported_modality");
    assert.equal(mapLiveError(new Error("RESOURCE_EXHAUSTED: quota exceeded")).code, "gemini_quota");
    assert.equal(mapLiveError(new Error("session 4291 ended")).code, "gemini_failed");
    assert.equal(mapLiveError(new Error("models/foo is not found")).code, "gemini_model_unavailable");
    assert.equal(mapLiveError(new Error("timed out waiting for Gemini Live reply")).code, "gemini_unreachable");
  } finally {
    console.warn = warn;
  }
});
