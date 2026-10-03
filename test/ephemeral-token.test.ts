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
const GEMINI_API_KEY = "super-secret-gemini-key";

function appConfig(extra: Record<string, string> = {}): Config {
  return loadConfig({
    GOOGLE_CLIENT_ID: "client-id.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "client-secret",
    SESSION_SECRET,
    PUBLIC_BASE_URL: "http://127.0.0.1:8787",
    // Legacy route is OFF by default; these tests exercise it explicitly.
    ENABLE_EPHEMERAL_TOKEN: "1",
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
  options: { config?: Config; fetchImpl?: FetchLike; now?: () => Date } = {},
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "waypoint-gemini-"));
  const store = openFileStore(join(dir, "store.json"));
  const server: Server = createApp({
    config: options.config ?? appConfig(),
    store,
    google,
    fetch: options.fetchImpl ?? (async () => {
      throw new Error("Google fetch was not stubbed");
    }),
    now: options.now,
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

test("ephemeral token requires a bearer", async () => {
  let called = false;
  await withApp(
    async (base) => {
      const response = await fetch(`${base}/v1/session/ephemeral-token`, { method: "POST" });
      assert.equal(response.status, 401);
      const body = (await response.json()) as { error: { code: string } };
      assert.equal(body.error.code, "unauthorized");
      assert.equal(called, false);
    },
    {
      config: appConfig({ GEMINI_API_KEY }),
      fetchImpl: async () => {
        called = true;
        throw new Error("should not call Google");
      },
    },
  );
});

test("ephemeral token is unavailable when the Gemini key is missing or blank", async () => {
  for (const extra of [{}, { GEMINI_API_KEY: "   " }]) {
    let called = false;
    await withApp(
      async (base) => {
        const token = await accessToken(base);
        const response = await fetch(`${base}/v1/session/ephemeral-token`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: "{}",
        });
        assert.equal(response.status, 503);
        const body = (await response.json()) as { error: { code: string } };
        assert.equal(body.error.code, "gemini_not_configured");
        assert.equal(called, false);
      },
      {
        config: appConfig(extra),
        fetchImpl: async () => {
          called = true;
          throw new Error("should not call Google");
        },
      },
    );
  }
});

test("ephemeral token returns Google's token without the API key", async () => {
  const now = new Date("2026-10-03T16:00:00.000Z");
  let requestUrl = "";
  let requestBody = "";
  const fetchImpl: FetchLike = async (input, init) => {
    requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    requestBody = String(init?.body ?? "");
    return new Response(
      JSON.stringify({
        name: "auth_tokens/live-once",
        expireTime: "2026-10-03T16:29:00.000Z",
        apiKey: GEMINI_API_KEY,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  await withApp(
    async (base) => {
      const token = await accessToken(base);
      const response = await fetch(`${base}/v1/session/ephemeral-token`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(response.status, 200);
      const raw = await response.text();
      assert.equal(raw.includes(GEMINI_API_KEY), false);
      assert.deepEqual(JSON.parse(raw), {
        token: "auth_tokens/live-once",
        expire_time: "2026-10-03T16:29:00.000Z",
        model: "gemini-flash-latest",
      });
      assert.equal(
        requestUrl,
        `https://generativelanguage.googleapis.com/v1alpha/auth_tokens?key=${encodeURIComponent(GEMINI_API_KEY)}`,
      );
      assert.deepEqual(JSON.parse(requestBody), {
        uses: 1,
        expireTime: "2026-10-03T16:30:00.000Z",
      });
    },
    {
      config: appConfig({ GEMINI_API_KEY }),
      fetchImpl,
      now: () => now,
    },
  );
});

test("a failed Google token response is 502 and does not leak secrets", async () => {
  const fetchImpl: FetchLike = async () =>
    new Response(
      JSON.stringify({
        error: "upstream failed",
        key: GEMINI_API_KEY,
        token: "secret-ephemeral-value",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );

  await withApp(
    async (base) => {
      const token = await accessToken(base);
      const response = await fetch(`${base}/v1/session/ephemeral-token`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      assert.equal(response.status, 502);
      const raw = await response.text();
      assert.equal(raw.includes(GEMINI_API_KEY), false);
      assert.equal(raw.includes("secret-ephemeral-value"), false);
      const body = JSON.parse(raw) as { error: { code: string; message: string } };
      assert.equal(body.error.code, "gemini_token_failed");
      assert.equal(body.error.message.length > 0, true);
      assert.equal(body.error.message.includes(GEMINI_API_KEY), false);
    },
    { config: appConfig({ GEMINI_API_KEY }), fetchImpl },
  );
});

test("ephemeral token route is disabled by default (404, never calls Google)", async () => {
  let called = false;
  await withApp(
    async (base) => {
      const token = await accessToken(base);
      for (const headers of [{}, { Authorization: `Bearer ${token}` }]) {
        const response = await fetch(`${base}/v1/session/ephemeral-token`, {
          method: "POST",
          headers,
        });
        assert.equal(response.status, 404);
        const body = (await response.json()) as { error: { code: string } };
        assert.equal(body.error.code, "ephemeral_token_disabled");
      }
      assert.equal(called, false);
    },
    {
      config: appConfig({ GEMINI_API_KEY, ENABLE_EPHEMERAL_TOKEN: "" }),
      fetchImpl: async () => {
        called = true;
        throw new Error("should not call Google");
      },
    },
  );
});
