import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { GoogleExchangeError, type GoogleClient } from "../src/auth/google.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { createApp } from "../src/server.ts";
import { openFileStore } from "../src/store/file.ts";

const SESSION_SECRET = "0123456789abcdef0123456789abcdef";

function readyConfig(): Config {
  return loadConfig({
    GOOGLE_CLIENT_ID: "client-id.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "client-secret",
    SESSION_SECRET,
    PUBLIC_BASE_URL: "http://127.0.0.1:8787",
    ACCESS_TOKEN_TTL_SECONDS: "900",
  });
}

function successGoogle(capture: { verifier: string } = { verifier: "" }): GoogleClient {
  return {
    async exchangeCode(input) {
      capture.verifier = input.codeVerifier;
      assert.equal(input.code, "auth-code");
      assert.equal(input.clientId, "client-id.apps.googleusercontent.com");
      assert.equal(input.clientSecret, "client-secret");
      assert.equal(input.redirectUri, "http://127.0.0.1:8787/v1/auth/google/callback");
      return { accessToken: "google-access", refreshToken: "google-refresh-secret" };
    },
    async fetchUserInfo() {
      return {
        sub: "google-sub-1",
        email: "student@cornell.edu",
        emailVerified: true,
        name: "Student",
        picture: "https://example.com/a.png",
      };
    },
  };
}

async function withApp(
  fn: (base: string, storePath: string) => Promise<void>,
  options: { config?: Config; google?: GoogleClient; now?: () => Date } = {},
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "waypoint-api-"));
  const storePath = join(dir, "store.json");
  const store = openFileStore(storePath);
  const server: Server = createApp({
    config: options.config ?? readyConfig(),
    store,
    google: options.google ?? successGoogle(),
    now: options.now,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${address.port}`, storePath);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

type Started = {
  authorization_url: string;
  state: string;
  poll_token: string;
  expires_in: number;
};

async function start(base: string): Promise<Started> {
  const response = await fetch(`${base}/v1/auth/google/start`, { method: "POST" });
  assert.equal(response.status, 200);
  return (await response.json()) as Started;
}

async function finish(base: string, started: Started) {
  const callback = await fetch(
    `${base}/v1/auth/google/callback?code=auth-code&state=${encodeURIComponent(started.state)}`,
  );
  const html = await callback.text();
  const poll = await fetch(
    `${base}/v1/auth/google/poll?poll_token=${encodeURIComponent(started.poll_token)}`,
  );
  const body = (await poll.json()) as {
    status: string;
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
    user: { id: string; email: string; email_verified: boolean; name: string; picture: string };
  };
  return { callbackStatus: callback.status, html, pollStatus: poll.status, body };
}

test("health reports file storage", async () => {
  await withApp(async (base) => {
    const response = await fetch(`${base}/health`);
    assert.deepEqual(await response.json(), {
      ok: true,
      service: "waypoint-api",
      storage: "file",
    });
  });
});

test("start refuses missing Google credentials and a short session secret", async () => {
  await withApp(
    async (base) => {
      const response = await fetch(`${base}/v1/auth/google/start`, { method: "POST" });
      assert.equal(response.status, 503);
      const body = (await response.json()) as { error: { code: string } };
      assert.equal(body.error.code, "google_not_configured");
    },
    { config: loadConfig({ SESSION_SECRET }) },
  );

  await withApp(
    async (base) => {
      const response = await fetch(`${base}/v1/auth/google/start`, { method: "POST" });
      assert.equal(response.status, 503);
      const body = (await response.json()) as { error: { code: string } };
      assert.equal(body.error.code, "session_secret_missing");
    },
    {
      config: loadConfig({
        GOOGLE_CLIENT_ID: "client-id",
        GOOGLE_CLIENT_SECRET: "client-secret",
        SESSION_SECRET: "too-short",
      }),
    },
  );
});

test("authorization URL is identity only and does not fold in previous tool scopes", async () => {
  const capture = { verifier: "" };
  await withApp(
    async (base) => {
      const started = await start(base);
      const url = new URL(started.authorization_url);
      assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
      assert.equal(url.searchParams.get("state"), started.state);
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      assert.equal(url.searchParams.get("scope"), "openid email profile");
      assert.equal(url.searchParams.get("include_granted_scopes"), "false");
      assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:8787/v1/auth/google/callback");
      assert.equal(started.authorization_url.includes(started.poll_token), false);
      assert.equal(started.expires_in, 600);

      await finish(base, started);
      const challenge = createHash("sha256").update(capture.verifier).digest("base64url");
      assert.equal(url.searchParams.get("code_challenge"), challenge);
    },
    { google: successGoogle(capture) },
  );
});

test("a bad callback state does not complete the poll", async () => {
  await withApp(async (base) => {
    const started = await start(base);
    const callback = await fetch(`${base}/v1/auth/google/callback?code=auth-code&state=nope`);
    assert.equal(callback.status, 400);
    assert.match(await callback.text(), /invalid or has expired/);
    const poll = await fetch(
      `${base}/v1/auth/google/poll?poll_token=${encodeURIComponent(started.poll_token)}`,
    );
    assert.equal(poll.status, 200);
    const body = (await poll.json()) as { status: string };
    assert.equal(body.status, "pending");
  });
});

test("completed login is delivered once and keeps the Google refresh token on the server", async () => {
  await withApp(async (base, storePath) => {
    const started = await start(base);
    const done = await finish(base, started);
    assert.equal(done.callbackStatus, 200);
    assert.match(done.html, /return to Waypoint/);
    assert.doesNotMatch(done.html, /Calendar|Drive/);
    assert.equal(done.pollStatus, 200);
    assert.equal(done.body.status, "complete");
    assert.equal(done.body.token_type, "Bearer");
    assert.equal(done.body.expires_in, 900);
    assert.equal(done.body.user.email, "student@cornell.edu");
    assert.equal(done.body.user.email_verified, true);
    assert.equal(JSON.stringify(done.body).includes("google-refresh-secret"), false);

    const stored = JSON.parse(await readFile(storePath, "utf8")) as {
      users: { google_refresh_token: string; email: string; calendar_connected?: boolean }[];
      toolConnections?: { toolId: string; status: string }[];
    };
    assert.equal(stored.users.length, 1);
    assert.equal(stored.users[0]?.google_refresh_token, "google-refresh-secret");
    assert.equal(stored.users[0]?.calendar_connected, false);
    assert.deepEqual(stored.toolConnections ?? [], []);

    const googleStatus = await fetch(`${base}/v1/google/status`, {
      headers: { Authorization: `Bearer ${done.body.access_token}` },
    });
    assert.equal(googleStatus.status, 200);
    const flags = (await googleStatus.json()) as {
      calendar_connected: boolean;
      drive_connected: boolean;
      google_connected: boolean;
      tools: { status: string }[];
    };
    assert.equal(flags.calendar_connected, false);
    assert.equal(flags.drive_connected, false);
    assert.equal(flags.google_connected, false);
    assert.equal(flags.tools.every((tool) => tool.status === "disconnected"), true);

    const again = await fetch(
      `${base}/v1/auth/google/poll?poll_token=${encodeURIComponent(started.poll_token)}`,
    );
    assert.equal(again.status, 404);
    const missing = (await again.json()) as { error: { code: string } };
    assert.equal(missing.error.code, "poll_not_found");

    const me = await fetch(`${base}/v1/me`, {
      headers: { Authorization: `Bearer ${done.body.access_token}` },
    });
    assert.equal(me.status, 200);
    const user = (await me.json()) as { email: string };
    assert.equal(user.email, "student@cornell.edu");
  });
});

test("cancelled Google sign-in surfaces on the poll", async () => {
  await withApp(async (base) => {
    const started = await start(base);
    const callback = await fetch(
      `${base}/v1/auth/google/callback?error=access_denied&state=${encodeURIComponent(started.state)}`,
    );
    assert.equal(callback.status, 400);
    const poll = await fetch(
      `${base}/v1/auth/google/poll?poll_token=${encodeURIComponent(started.poll_token)}`,
    );
    assert.equal(poll.status, 200);
    const body = (await poll.json()) as { status: string; error: { code: string } };
    assert.equal(body.status, "error");
    assert.equal(body.error.code, "google_denied");
  });
});

test("a failed code exchange is an error poll", async () => {
  const google: GoogleClient = {
    async exchangeCode() {
      throw new GoogleExchangeError("nope");
    },
    async fetchUserInfo() {
      throw new Error("unused");
    },
  };
  await withApp(
    async (base) => {
      const started = await start(base);
      const callback = await fetch(
        `${base}/v1/auth/google/callback?code=auth-code&state=${encodeURIComponent(started.state)}`,
      );
      assert.equal(callback.status, 502);
      const poll = await fetch(
        `${base}/v1/auth/google/poll?poll_token=${encodeURIComponent(started.poll_token)}`,
      );
      const body = (await poll.json()) as { status: string; error: { code: string } };
      assert.equal(body.status, "error");
      assert.equal(body.error.code, "google_exchange_failed");
    },
    { google },
  );
});

test("an unused poll expires", async () => {
  let now = new Date("2026-10-03T16:00:00.000Z");
  await withApp(
    async (base) => {
      const started = await start(base);
      now = new Date(now.getTime() + 601_000);
      const poll = await fetch(
        `${base}/v1/auth/google/poll?poll_token=${encodeURIComponent(started.poll_token)}`,
      );
      assert.equal(poll.status, 410);
      const body = (await poll.json()) as { error: { code: string } };
      assert.equal(body.error.code, "poll_expired");
    },
    { now: () => now },
  );
});

test("refresh rotates, and replaying the old token revokes the session", async () => {
  await withApp(async (base) => {
    const done = await finish(base, await start(base));
    const first = await fetch(`${base}/v1/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: done.body.refresh_token }),
    });
    assert.equal(first.status, 200);
    const rotated = (await first.json()) as { access_token: string; refresh_token: string };
    assert.notEqual(rotated.refresh_token, done.body.refresh_token);

    const replay = await fetch(`${base}/v1/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: done.body.refresh_token }),
    });
    assert.equal(replay.status, 401);
    const replayBody = (await replay.json()) as { error: { code: string } };
    assert.equal(replayBody.error.code, "refresh_reuse");

    const after = await fetch(`${base}/v1/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: rotated.refresh_token }),
    });
    assert.equal(after.status, 401);
    const afterBody = (await after.json()) as { error: { code: string } };
    assert.equal(afterBody.error.code, "invalid_refresh");
  });
});

test("me requires a bearer token and sign-out revokes refresh", async () => {
  await withApp(async (base) => {
    const anonymous = await fetch(`${base}/v1/me`);
    assert.equal(anonymous.status, 401);

    const done = await finish(base, await start(base));
    const signedOut = await fetch(`${base}/v1/auth/sign-out`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${done.body.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ all: true }),
    });
    assert.equal(signedOut.status, 204);

    const refresh = await fetch(`${base}/v1/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: done.body.refresh_token }),
    });
    assert.equal(refresh.status, 401);
  });
});

test("localhost origins are reflected for the webview", async () => {
  await withApp(async (base) => {
    const response = await fetch(`${base}/health`, {
      headers: { Origin: "http://localhost:1420" },
    });
    assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:1420");
  });
});
