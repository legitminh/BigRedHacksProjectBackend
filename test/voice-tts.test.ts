import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { GoogleClient } from "../src/auth/google.ts";
import { loadConfig, type Config } from "../src/config.ts";
import type { FetchLike } from "../src/gemini/ephemeral.ts";
import { createApp } from "../src/server.ts";
import { openFileStore } from "../src/store/file.ts";

const SESSION_SECRET = "0123456789abcdef0123456789abcdef";
const COACH_TOKEN = "coach-shared-secret-token";

function appConfig(extra: Record<string, string> = {}): Config {
  return loadConfig({
    GOOGLE_CLIENT_ID: "client-id.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "client-secret",
    SESSION_SECRET,
    PUBLIC_BASE_URL: "http://127.0.0.1:8787",
    COACH_API_TOKEN: COACH_TOKEN,
    OLLAMA_BASE_URL: "http://127.0.0.1:11434",
    ...extra,
  });
}

const google: GoogleClient = {
  async exchangeCode() {
    return { accessToken: "google-access", refreshToken: "google-refresh-secret" };
  },
  async fetchUserInfo() {
    return {
      sub: "google-sub-voice",
      email: "voice@cornell.edu",
      emailVerified: true,
      name: "Voice",
      picture: null,
    };
  },
};

async function withApp(
  fn: (base: string) => Promise<void>,
  options: { config?: Config; fetchImpl?: FetchLike } = {},
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "waypoint-voice-"));
  const store = openFileStore(join(dir, "store.json"));
  const server: Server = createApp({
    config: options.config ?? appConfig(),
    store,
    google,
    fetch: options.fetchImpl ?? (async () => {
      throw new Error("fetch was not stubbed");
    }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test("voice tts requires auth", async () => {
  await withApp(async (base) => {
    const response = await fetch(`${base}/v1/voice/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Back to the problem set." }),
    });
    assert.equal(response.status, 401);
  });
});

test("voice tts returns 503 when XAI_API_KEY unset", async () => {
  await withApp(async (base) => {
    const response = await fetch(`${base}/v1/voice/tts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${COACH_TOKEN}`,
      },
      body: JSON.stringify({ text: "Back to the problem set." }),
    });
    assert.equal(response.status, 503);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, "xai_tts_not_configured");
  });
});

test("voice tts proxies to xAI with coach token", async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const fakeMp3 = Buffer.from([0xff, 0xfb, 0x90, 0x00, ...Array.from({ length: 64 }, () => 1)]);
  await withApp(
    async (base) => {
      const response = await fetch(`${base}/v1/voice/tts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${COACH_TOKEN}`,
        },
        body: JSON.stringify({ text: "Leave Instagram — finish the draft." }),
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /audio\/mpeg/);
      assert.equal(response.headers.get("x-waypoint-tts-engine"), "xai-grok");
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.length, fakeMp3.length);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.url, "https://api.x.ai/v1/tts");
      const payload = JSON.parse(calls[0]!.body) as { text: string; voice_id: string };
      assert.match(payload.text, /Instagram/);
      assert.equal(payload.voice_id, "eve");
    },
    {
      config: appConfig({ XAI_API_KEY: "xai-test-key", XAI_TTS_VOICE: "eve" }),
      fetchImpl: async (input, init) => {
        const url = typeof input === "string" ? input : input.toString();
        calls.push({ url, body: String(init?.body ?? "") });
        return new Response(fakeMp3, {
          status: 200,
          headers: { "Content-Type": "audio/mpeg" },
        });
      },
    },
  );
});

test("voice tts unwraps xAI JSON audio so the desktop can play it", async () => {
  const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x00, ...Array.from({ length: 64 }, () => 2)]);
  await withApp(
    async (base) => {
      const response = await fetch(`${base}/v1/voice/tts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${COACH_TOKEN}`,
        },
        body: JSON.stringify({ text: "Back to the draft." }),
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /audio\/mpeg/);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.deepEqual(bytes, mp3);
    },
    {
      config: appConfig({ XAI_API_KEY: "xai-test-key" }),
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            audio: mp3.toString("base64"),
            content_type: "audio/mpeg",
            duration: 0.4,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    },
  );
});

test("voice health reports configured flag", async () => {
  await withApp(async (base) => {
    const off = await fetch(`${base}/v1/voice/health`);
    assert.equal(off.status, 503);
    const offBody = (await off.json()) as { configured: boolean };
    assert.equal(offBody.configured, false);
  });

  await withApp(
    async (base) => {
      const on = await fetch(`${base}/v1/voice/health`);
      assert.equal(on.status, 200);
      const body = (await on.json()) as { configured: boolean; engine: string };
      assert.equal(body.configured, true);
      assert.equal(body.engine, "xai-grok");
    },
    { config: appConfig({ XAI_API_KEY: "xai-test-key" }) },
  );
});
