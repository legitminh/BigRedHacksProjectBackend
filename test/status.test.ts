import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { GoogleClient } from "../src/auth/google.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { createApp } from "../src/server.ts";
import { clearStatusCaches, type StatusResponse } from "../src/status/aggregate.ts";
import { openFileStore } from "../src/store/file.ts";

const SESSION_SECRET = "0123456789abcdef0123456789abcdef";
const GEMINI_KEY = "test-gemini-key";

function appConfig(extra: Record<string, string> = {}): Config {
  return loadConfig({
    GOOGLE_CLIENT_ID: "client-id.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "client-secret",
    SESSION_SECRET,
    PUBLIC_BASE_URL: "http://127.0.0.1:8787",
    ACCESS_TOKEN_TTL_SECONDS: "900",
    GEMINI_API_KEY: GEMINI_KEY,
    OLLAMA_BASE_URL: "http://127.0.0.1:11434",
    OLLAMA_MODEL: "qwen2.5:0.5b",
    OLLAMA_CHAT_MODEL: "qwen2.5:7b",
    ...extra,
  });
}

function successGoogle(): GoogleClient {
  return {
    async exchangeCode() {
      return { accessToken: "google-access", refreshToken: "google-refresh-secret" };
    },
    async fetchUserInfo() {
      return {
        sub: "google-sub-status",
        email: "status@cornell.edu",
        emailVerified: true,
        name: "Status Student",
        picture: null,
      };
    },
  };
}

async function withApp(
  fn: (base: string) => Promise<void>,
  options: {
    config?: Config;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<void> {
  clearStatusCaches();
  const dir = await mkdtemp(join(tmpdir(), "waypoint-status-"));
  const store = openFileStore(join(dir, "store.json"));
  const server: Server = createApp({
    config: options.config ?? appConfig(),
    store,
    google: successGoogle(),
    fetch: options.fetchImpl,
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

async function signIn(base: string): Promise<string> {
  const start = await fetch(`${base}/v1/auth/google/start`, { method: "POST" });
  assert.equal(start.status, 200);
  const body = (await start.json()) as { poll_token: string; state: string };
  const callback = await fetch(
    `${base}/v1/auth/google/callback?code=auth-code&state=${encodeURIComponent(body.state)}`,
  );
  assert.equal(callback.status, 200);
  for (let i = 0; i < 20; i++) {
    const poll = await fetch(
      `${base}/v1/auth/google/poll?poll_token=${encodeURIComponent(body.poll_token)}`,
    );
    assert.equal(poll.status, 200);
    const payload = (await poll.json()) as {
      status: string;
      access_token?: string;
    };
    if (payload.status === "complete" && payload.access_token) {
      return payload.access_token;
    }
  }
  throw new Error("sign-in poll did not complete");
}

function stubFetch(handlers: {
  geminiOk?: boolean;
  geminiQuota?: boolean;
  ollamaOk?: boolean;
  models?: string[];
}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("generativelanguage.googleapis.com")) {
      if (handlers.geminiQuota) {
        return new Response(JSON.stringify({ error: { message: "Resource exhausted", status: "RESOURCE_EXHAUSTED" } }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (handlers.geminiOk === false) {
        return new Response(JSON.stringify({ error: { message: "API key invalid" } }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ models: [{ name: "models/gemini-flash-latest" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/tags")) {
      if (handlers.ollamaOk === false) {
        throw new Error("ECONNREFUSED");
      }
      const models = (handlers.models ?? ["qwen2.5:0.5b", "qwen2.5:7b"]).map((name) => ({ name }));
      return new Response(JSON.stringify({ models }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return fetch(input, init);
  }) as typeof fetch;
}

function byId(body: StatusResponse, id: string) {
  const row = body.services.find((s) => s.id === id);
  assert.ok(row, `missing service ${id}`);
  return row;
}

test("GET /v1/status reports config-only for anonymous callers (no live probes)", async () => {
  let geminiHits = 0;
  let ollamaHits = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("generativelanguage.googleapis.com")) geminiHits += 1;
    if (url.includes("/api/tags")) ollamaHits += 1;
    return stubFetch({ geminiOk: true, ollamaOk: true })(input, init);
  }) as typeof fetch;

  await withApp(
    async (base) => {
      const response = await fetch(`${base}/v1/status`);
      assert.equal(response.status, 200);
      const body = (await response.json()) as StatusResponse;
      assert.equal(body.ok, true);
      assert.equal(typeof body.checked_at, "string");
      assert.equal(body.cache_ttl_seconds, 30);
      assert.equal(byId(body, "gemini").state, "ok");
      assert.equal(byId(body, "gemini").status, "Configured");
      assert.equal(byId(body, "ollama").state, "ok");
      assert.equal(byId(body, "ollama").status, "Configured");
      assert.equal(byId(body, "chat_provider").state, "ok");
      assert.equal(byId(body, "api").state, "ok");
      assert.equal(byId(body, "google_oauth").state, "ok");
      assert.equal(byId(body, "account").state, "warn");
      assert.equal(byId(body, "google").state, "warn");
      assert.equal(byId(body, "presage").state, "warn");
      assert.equal(byId(body, "presage").status, "Degraded");
      assert.equal(geminiHits, 0);
      assert.equal(ollamaHits, 0);
    },
    { fetchImpl },
  );
});

test("GET /v1/status marks Gemini quota and Ollama down when signed in", async () => {
  await withApp(
    async (base) => {
      const access = await signIn(base);
      const response = await fetch(`${base}/v1/status`, {
        headers: { Authorization: `Bearer ${access}` },
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as StatusResponse;
      assert.equal(body.ok, false);
      assert.equal(byId(body, "gemini").state, "err");
      assert.equal(byId(body, "gemini").status, "Quota");
      assert.equal(byId(body, "ollama").state, "err");
      assert.equal(byId(body, "ollama").status, "Offline");
    },
    { fetchImpl: stubFetch({ geminiQuota: true, ollamaOk: false }) },
  );
});

test("GET /v1/status enriches account + Google when signed in", async () => {
  await withApp(
    async (base) => {
      const access = await signIn(base);
      const response = await fetch(`${base}/v1/status`, {
        headers: { Authorization: `Bearer ${access}` },
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as StatusResponse;
      assert.equal(byId(body, "account").state, "ok");
      assert.match(byId(body, "account").detail, /status@cornell\.edu/);
      // Desktop Google sign-in also grants Calendar/Drive scopes.
      assert.equal(byId(body, "google").state, "ok");
      assert.match(byId(body, "google").detail, /Calendar and Drive/i);
    },
    { fetchImpl: stubFetch({ geminiOk: true, ollamaOk: true }) },
  );
});

test("GET /v1/status caches Gemini probe within TTL when signed in", async () => {
  let geminiHits = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("generativelanguage.googleapis.com")) {
      geminiHits += 1;
      return new Response(JSON.stringify({ models: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/tags")) {
      return new Response(JSON.stringify({ models: [{ name: "qwen2.5:0.5b" }, { name: "qwen2.5:7b" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return fetch(input, init);
  }) as typeof fetch;

  await withApp(
    async (base) => {
      const access = await signIn(base);
      const headers = { Authorization: `Bearer ${access}` };
      const a = await fetch(`${base}/v1/status`, { headers });
      const b = await fetch(`${base}/v1/status`, { headers });
      assert.equal(a.status, 200);
      assert.equal(b.status, 200);
      assert.equal(geminiHits, 1);
      const connected = (await a.json()) as StatusResponse;
      assert.equal(byId(connected, "gemini").status, "Connected");
    },
    { fetchImpl },
  );
});

test("GET /v1/status reports missing Gemini key without calling Google", async () => {
  let geminiHits = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("generativelanguage.googleapis.com")) {
      geminiHits += 1;
    }
    if (url.includes("/api/tags")) {
      return new Response(JSON.stringify({ models: [{ name: "qwen2.5:0.5b" }, { name: "qwen2.5:7b" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return fetch(input, init);
  }) as typeof fetch;

  await withApp(
    async (base) => {
      const response = await fetch(`${base}/v1/status`);
      const body = (await response.json()) as StatusResponse;
      assert.equal(byId(body, "gemini").state, "err");
      assert.equal(byId(body, "gemini").status, "Offline");
      assert.match(byId(body, "gemini").detail, /Cloud coach is not set up/i);
      assert.equal(geminiHits, 0);
    },
    { config: appConfig({ GEMINI_API_KEY: "" }), fetchImpl },
  );
});
