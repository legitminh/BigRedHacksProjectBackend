import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { GoogleClient } from "../src/auth/google.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { originAllowed } from "../src/http.ts";
import type { FetchLike } from "../src/http.ts";
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
      sub: "google-sub-1",
      email: "student@cornell.edu",
      emailVerified: true,
      name: "Student",
      picture: null,
    };
  },
};

async function withApp(
  fn: (base: string) => Promise<void>,
  options: { config?: Config; fetchImpl?: FetchLike } = {},
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "waypoint-coach-"));
  const store = openFileStore(join(dir, "store.json"));
  const server: Server = createApp({
    config: options.config ?? appConfig(),
    store,
    google,
    fetch: options.fetchImpl ?? (async () => {
      throw new Error("Ollama fetch was not stubbed");
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

async function accessToken(base: string): Promise<string> {
  const start = await fetch(`${base}/v1/auth/google/start`, { method: "POST" });
  assert.equal(start.status, 200);
  const started = (await start.json()) as { state: string; poll_token: string };
  const callback = await fetch(
    `${base}/v1/auth/google/callback?code=auth-code&state=${encodeURIComponent(started.state)}`,
  );
  assert.equal(callback.status, 200);
  const poll = await fetch(
    `${base}/v1/auth/google/poll?poll_token=${encodeURIComponent(started.poll_token)}`,
  );
  assert.equal(poll.status, 200);
  const body = (await poll.json()) as { access_token: string };
  return body.access_token;
}

test("coach tags requires auth", async () => {
  await withApp(async (base) => {
    const response = await fetch(`${base}/v1/coach/api/tags`);
    assert.equal(response.status, 401);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, "unauthorized");
  });
});

test("coach tags proxies with COACH_API_TOKEN", async () => {
  const calls: string[] = [];
  await withApp(
    async (base) => {
      const response = await fetch(`${base}/v1/coach/api/tags`, {
        headers: { Authorization: `Bearer ${COACH_TOKEN}` },
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { models: { name: string }[] };
      assert.deepEqual(body.models, [{ name: "qwen2.5:0.5b" }]);
      assert.deepEqual(calls, ["GET http://127.0.0.1:11434/api/tags"]);
    },
    {
      fetchImpl: async (url, init) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        return new Response(JSON.stringify({ models: [{ name: "qwen2.5:0.5b" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  );
});

test("coach generate accepts JWT and forces stream false", async () => {
  let posted: unknown;
  await withApp(
    async (base) => {
      const token = await accessToken(base);
      const response = await fetch(`${base}/v1/coach/api/generate`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "qwen2.5:0.5b", prompt: "hi", stream: true }),
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { response: string };
      assert.equal(body.response, "ok");
      assert.deepEqual(posted, {
        model: "qwen2.5:0.5b",
        prompt: "hi",
        stream: false,
      });
    },
    {
      fetchImpl: async (url, init) => {
        assert.equal(url, "http://127.0.0.1:11434/api/generate");
        assert.equal(init?.method, "POST");
        posted = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ response: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  );
});

test("coach generate forwards format json to Ollama", async () => {
  let posted: unknown;
  await withApp(
    async (base) => {
      const token = await accessToken(base);
      const response = await fetch(`${base}/v1/coach/api/generate`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "qwen2.5:0.5b",
          prompt: "hi",
          format: "json",
          not_allowed: "drop-me",
        }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(posted, {
        model: "qwen2.5:0.5b",
        prompt: "hi",
        stream: false,
        format: "json",
      });
    },
    {
      fetchImpl: async (url, init) => {
        assert.equal(url, "http://127.0.0.1:11434/api/generate");
        posted = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ response: "{}" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  );
});

test("coach tags returns clear error when Ollama is down", async () => {
  await withApp(
    async (base) => {
      const response = await fetch(`${base}/v1/coach/api/tags`, {
        headers: { Authorization: `Bearer ${COACH_TOKEN}` },
      });
      assert.equal(response.status, 502);
      const body = (await response.json()) as { error: { code: string; message: string } };
      assert.equal(body.error.code, "ollama_unreachable");
      assert.match(body.error.message, /Could not reach the lock-in coach/i);
    },
    {
      fetchImpl: async () => {
        throw new Error("fetch failed", { cause: { code: "ECONNREFUSED" } });
      },
    },
  );
});

test("coach health reports ollama_not_configured when base URL blank", async () => {
  await withApp(
    async (base) => {
      const response = await fetch(`${base}/v1/coach/health`, {
        headers: { Authorization: `Bearer ${COACH_TOKEN}` },
      });
      assert.equal(response.status, 503);
      const body = (await response.json()) as { ok: boolean; error: { code: string } };
      assert.equal(body.ok, false);
      assert.equal(body.error.code, "ollama_not_configured");
    },
    {
      config: appConfig({ OLLAMA_BASE_URL: "" }),
    },
  );
});

test("CORS allows tauri origins", () => {
  assert.equal(originAllowed("tauri://localhost", []), true);
  assert.equal(originAllowed("https://tauri.localhost", []), true);
  assert.equal(originAllowed("http://tauri.localhost", []), true);
  assert.equal(originAllowed("http://127.0.0.1:1420", []), true);
  assert.equal(originAllowed("https://evil.example", []), false);
  assert.equal(originAllowed("https://evil.example", ["https://evil.example"]), true);
});
