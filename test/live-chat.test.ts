import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { WebSocketServer } from "ws";

import { geminiLiveChat } from "../src/gemini/liveChat.ts";
import { HttpError } from "../src/http.ts";

test("geminiLiveChat opens an isolated TEXT Live session and returns the reply", async () => {
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
        sawTextSetup = msg.setup.generationConfig?.responseModalities?.[0] === "TEXT";
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
              modelTurn: { parts: [{ text: "Do the reading for Chem." }] },
              turnComplete: true,
            },
          }),
        );
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
