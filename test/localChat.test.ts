import assert from "node:assert/strict";
import { test } from "node:test";

import { loadConfig, parseLocalChatProvider } from "../src/config.ts";
import {
  isLocalChatForced,
  selectChatBackend,
} from "../src/gemini/localChat.ts";

test("parseLocalChatProvider maps aliases onto ollama vs gemini", () => {
  assert.equal(parseLocalChatProvider(undefined), "gemini");
  assert.equal(parseLocalChatProvider(""), "gemini");
  assert.equal(parseLocalChatProvider("gemini"), "gemini");
  assert.equal(parseLocalChatProvider("cloud"), "gemini");
  assert.equal(parseLocalChatProvider("GOOGLE"), "gemini");
  assert.equal(parseLocalChatProvider("ollama"), "ollama");
  assert.equal(parseLocalChatProvider("llama"), "ollama");
  assert.equal(parseLocalChatProvider("local"), "ollama");
  assert.equal(parseLocalChatProvider("on-device"), "ollama");
  assert.equal(parseLocalChatProvider("mystery"), "gemini");
});

test("loadConfig exposes localChatProvider from LOCAL_CHAT_PROVIDER", () => {
  const gemini = loadConfig({ LOCAL_CHAT_PROVIDER: "gemini" });
  assert.equal(gemini.localChatProvider, "gemini");

  const local = loadConfig({ LOCAL_CHAT_PROVIDER: "llama" });
  assert.equal(local.localChatProvider, "ollama");
});

test("loadConfig defaults geminiOverviewModel to gemini-3.5-flash", () => {
  const cfg = loadConfig({});
  assert.equal(cfg.geminiModel, "gemini-3.5-flash-lite");
  assert.equal(cfg.geminiOverviewModel, "gemini-3.5-flash");
  const custom = loadConfig({ GEMINI_OVERVIEW_MODEL: "gemini-3.8-flash" });
  assert.equal(custom.geminiOverviewModel, "gemini-3.8-flash");
});

test("selectChatBackend forces Ollama when LOCAL_CHAT_PROVIDER=ollama even with Gemini key", () => {
  assert.equal(
    selectChatBackend({
      localChatProvider: "ollama",
      geminiApiKey: "secret-key",
      ollamaBaseUrl: "http://127.0.0.1:11434",
    }),
    "ollama",
  );
  assert.equal(
    isLocalChatForced({ localChatProvider: "ollama" }),
    true,
  );
});

test("selectChatBackend prefers Gemini for cloud companion when provider is gemini", () => {
  assert.equal(
    selectChatBackend({
      localChatProvider: "gemini",
      geminiApiKey: "secret-key",
      ollamaBaseUrl: "http://127.0.0.1:11434",
    }),
    "gemini",
  );
  assert.equal(
    isLocalChatForced({ localChatProvider: "gemini" }),
    false,
  );
});

test("selectChatBackend falls back to Ollama when Gemini key missing", () => {
  assert.equal(
    selectChatBackend({
      localChatProvider: "gemini",
      geminiApiKey: null,
      ollamaBaseUrl: "http://127.0.0.1:11434",
    }),
    "ollama",
  );
});
