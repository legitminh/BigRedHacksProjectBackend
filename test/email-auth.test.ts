import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { GoogleClient } from "../src/auth/google.ts";
import { hashToken } from "../src/auth/tokens.ts";
import { loadConfig, type Config } from "../src/config.ts";
import type { Mailer, LoginCodeMessage } from "../src/mailer.ts";
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

function successGoogle(): GoogleClient {
  return {
    async exchangeCode() {
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

function captureMailer(sent: LoginCodeMessage[]): Mailer {
  return {
    async sendLoginCode(message) {
      sent.push(message);
    },
  };
}

async function withApp(
  fn: (base: string, storePath: string) => Promise<void>,
  options: { config?: Config; google?: GoogleClient; mailer?: Mailer; now?: () => Date } = {},
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "waypoint-email-"));
  const storePath = join(dir, "store.json");
  const store = openFileStore(storePath);
  const server: Server = createApp({
    config: options.config ?? readyConfig(),
    store,
    google: options.google ?? successGoogle(),
    mailer: options.mailer ?? captureMailer([]),
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

async function startEmail(base: string, email: string) {
  const response = await fetch(`${base}/v1/auth/email/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as { status?: string; expires_in?: number; error?: { code: string } } };
}

test("invalid email is rejected and does not send a code", async () => {
  const sent: LoginCodeMessage[] = [];
  await withApp(
    async (base) => {
      for (const email of ["not-an-email", "", "a@b", "missing-at-sign"]) {
        const started = await startEmail(base, email);
        assert.equal(started.status, 400);
        assert.equal(started.body.error?.code, "invalid_email");
      }
      const missing = await fetch(`${base}/v1/auth/email/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(missing.status, 400);
      const body = (await missing.json()) as { error: { code: string } };
      assert.equal(body.error.code, "invalid_email");
      assert.equal(sent.length, 0);
    },
    { mailer: captureMailer(sent) },
  );
});

test("start delivers a code to the mailer and hides it from the HTTP body", async () => {
  const sent: LoginCodeMessage[] = [];
  await withApp(
    async (base) => {
      const started = await startEmail(base, " Student@Cornell.edu ");
      assert.equal(started.status, 200);
      assert.deepEqual(started.body, { status: "sent", expires_in: 600 });
      assert.equal(started.text.includes(sent[0]?.code ?? "missing"), false);
      assert.equal(sent.length, 1);
      assert.equal(sent[0]?.to, "student@cornell.edu");
      assert.match(sent[0]?.code ?? "", /^\d{6}$/);
      assert.equal(sent[0]?.expiresIn, 600);

      const unknown = await startEmail(base, "nobody@cornell.edu");
      assert.equal(unknown.status, 200);
      assert.deepEqual(unknown.body, { status: "sent", expires_in: 600 });
      assert.equal(unknown.text.includes(sent[1]?.code ?? "missing"), false);
    },
    { mailer: captureMailer(sent) },
  );
});

test("verify issues a bearer token that works on GET /v1/me", async () => {
  const sent: LoginCodeMessage[] = [];
  await withApp(
    async (base, storePath) => {
      await startEmail(base, "student@cornell.edu");
      const code = sent[0]?.code;
      assert.ok(code);
      const response = await fetch(`${base}/v1/auth/email/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "student@cornell.edu", code }),
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        token_type: string;
        access_token: string;
        refresh_token: string;
        expires_in: number;
        user: { id: string; email: string; email_verified: boolean; name: null; picture: null };
      };
      assert.equal(body.token_type, "Bearer");
      assert.equal(body.expires_in, 900);
      assert.equal(typeof body.access_token, "string");
      assert.equal(typeof body.refresh_token, "string");
      assert.equal(body.user.email, "student@cornell.edu");
      assert.equal(body.user.email_verified, true);
      assert.equal("status" in body, false);

      const me = await fetch(`${base}/v1/me`, {
        headers: { Authorization: `Bearer ${body.access_token}` },
      });
      assert.equal(me.status, 200);
      const user = (await me.json()) as { id: string; email: string };
      assert.equal(user.id, body.user.id);
      assert.equal(user.email, "student@cornell.edu");

      const refreshed = await fetch(`${base}/v1/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: body.refresh_token }),
      });
      assert.equal(refreshed.status, 200);

      const stored = JSON.parse(await readFile(storePath, "utf8")) as {
        users: { google_sub: string | null; email: string; email_verified: boolean }[];
        emailCodes: { codeHash: string; consumedAt: string | null }[];
      };
      assert.equal(stored.users.length, 1);
      assert.equal(stored.users[0]?.google_sub, null);
      assert.equal(stored.users[0]?.email_verified, true);
      assert.equal(stored.emailCodes[0]?.codeHash, hashToken(code));
      assert.ok(stored.emailCodes[0]?.consumedAt);
    },
    { mailer: captureMailer(sent) },
  );
});

test("a wrong code is 401 and does not consume the real code", async () => {
  const sent: LoginCodeMessage[] = [];
  await withApp(
    async (base) => {
      await startEmail(base, "student@cornell.edu");
      const issued = sent[0]?.code ?? "";
      const wrongCode = issued === "000000" ? "000001" : "000000";
      const wrong = await fetch(`${base}/v1/auth/email/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "student@cornell.edu", code: wrongCode }),
      });
      assert.equal(wrong.status, 401);
      const body = (await wrong.json()) as { error: { code: string; message: string } };
      assert.equal(body.error.code, "invalid_code");

      const right = await fetch(`${base}/v1/auth/email/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "student@cornell.edu", code: sent[0]?.code }),
      });
      assert.equal(right.status, 200);
    },
    { mailer: captureMailer(sent) },
  );
});

test("a consumed code cannot be reused", async () => {
  const sent: LoginCodeMessage[] = [];
  await withApp(
    async (base) => {
      await startEmail(base, "student@cornell.edu");
      const payload = JSON.stringify({ email: "student@cornell.edu", code: sent[0]?.code });
      const first = await fetch(`${base}/v1/auth/email/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      });
      assert.equal(first.status, 200);
      const second = await fetch(`${base}/v1/auth/email/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      });
      assert.equal(second.status, 401);
      const body = (await second.json()) as { error: { code: string } };
      assert.equal(body.error.code, "invalid_code");
    },
    { mailer: captureMailer(sent) },
  );
});

test("an expired code is rejected", async () => {
  const sent: LoginCodeMessage[] = [];
  let now = new Date("2026-10-03T16:00:00.000Z");
  await withApp(
    async (base) => {
      await startEmail(base, "student@cornell.edu");
      now = new Date(now.getTime() + 600_000);
      const response = await fetch(`${base}/v1/auth/email/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "student@cornell.edu", code: sent[0]?.code }),
      });
      assert.equal(response.status, 401);
      const body = (await response.json()) as { error: { code: string } };
      assert.equal(body.error.code, "invalid_code");
    },
    { mailer: captureMailer(sent), now: () => now },
  );
});

test("a new code replaces the previous one", async () => {
  const sent: LoginCodeMessage[] = [];
  await withApp(
    async (base) => {
      await startEmail(base, "student@cornell.edu");
      await startEmail(base, "student@cornell.edu");
      const oldCode = await fetch(`${base}/v1/auth/email/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "student@cornell.edu", code: sent[0]?.code }),
      });
      assert.equal(oldCode.status, 401);
      const newer = await fetch(`${base}/v1/auth/email/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "student@cornell.edu", code: sent[1]?.code }),
      });
      assert.equal(newer.status, 200);
    },
    { mailer: captureMailer(sent) },
  );
});

test("google sign-in attaches to the existing email user", async () => {
  const sent: LoginCodeMessage[] = [];
  await withApp(
    async (base, storePath) => {
      await startEmail(base, "student@cornell.edu");
      const verified = await fetch(`${base}/v1/auth/email/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "student@cornell.edu", code: sent[0]?.code }),
      });
      const emailUser = (await verified.json()) as { user: { id: string } };
      const started = await fetch(`${base}/v1/auth/google/start`, { method: "POST" });
      const startBody = (await started.json()) as { state: string };
      const callback = await fetch(
        `${base}/v1/auth/google/callback?code=auth-code&state=${encodeURIComponent(startBody.state)}`,
      );
      assert.equal(callback.status, 200);
      const stored = JSON.parse(await readFile(storePath, "utf8")) as {
        users: { id: string; google_sub: string | null; email: string }[];
      };
      assert.equal(stored.users.length, 1);
      assert.equal(stored.users[0]?.id, emailUser.user.id);
      assert.equal(stored.users[0]?.google_sub, "google-sub-1");
      assert.equal(stored.users[0]?.email, "student@cornell.edu");
    },
    { mailer: captureMailer(sent), google: successGoogle() },
  );
});
