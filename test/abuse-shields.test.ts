import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { EmailCodeGuard } from "../src/auth/email.ts";
import type { GoogleClient } from "../src/auth/google.ts";
import { loadConfig, type Config } from "../src/config.ts";
import type { FetchLike } from "../src/gemini/ephemeral.ts";
import type { LoginCodeMessage, Mailer } from "../src/mailer.ts";
import { RateLimiter, clientIp } from "../src/security/rateLimit.ts";
import { createApp, type AppDeps } from "../src/server.ts";
import { clearStatusCaches, type StatusResponse } from "../src/status/aggregate.ts";
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
    GEMINI_API_KEY: "test-gemini-key",
    OLLAMA_BASE_URL: "http://127.0.0.1:11434",
    OLLAMA_MODEL: "qwen2.5:0.5b",
    OLLAMA_VISION_MODEL: "moondream",
    OLLAMA_CHAT_MODEL: "qwen2.5:7b",
    ...extra,
  });
}

const google: GoogleClient = {
  async exchangeCode() {
    return { accessToken: "google-access", refreshToken: "google-refresh-secret" };
  },
  async fetchUserInfo() {
    return {
      sub: "google-sub-shield",
      email: "shield@cornell.edu",
      emailVerified: true,
      name: "Shield",
      picture: null,
    };
  },
};

async function withApp(
  fn: (base: string) => Promise<void>,
  options: Partial<Pick<AppDeps, "mailer" | "now" | "fetch" | "rateRules" | "emailCodeGuard">> & {
    config?: Config;
  } = {},
): Promise<void> {
  clearStatusCaches();
  const dir = await mkdtemp(join(tmpdir(), "waypoint-shields-"));
  const server: Server = createApp({
    config: options.config ?? appConfig(),
    store: openFileStore(join(dir, "store.json")),
    google,
    mailer: options.mailer,
    now: options.now,
    rateRules: options.rateRules,
    emailCodeGuard: options.emailCodeGuard,
    fetch:
      options.fetch ??
      (async () => {
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

function json(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function signIn(base: string): Promise<string> {
  const start = await fetch(`${base}/v1/auth/google/start`, { method: "POST" });
  const started = (await start.json()) as { state: string; poll_token: string };
  const callback = await fetch(
    `${base}/v1/auth/google/callback?code=auth-code&state=${encodeURIComponent(started.state)}`,
  );
  assert.equal(callback.status, 200);
  const poll = await fetch(
    `${base}/v1/auth/google/poll?poll_token=${encodeURIComponent(started.poll_token)}`,
  );
  const body = (await poll.json()) as { status: string; access_token?: string };
  assert.equal(body.status, "complete");
  return body.access_token as string;
}

function captureMailer(sent: LoginCodeMessage[]): Mailer {
  return {
    async sendLoginCode(message) {
      sent.push(message);
    },
  };
}

// ---------------------------------------------------------------- RateLimiter

test("RateLimiter allows `limit` hits per window, reports Retry-After, then resets", () => {
  const limiter = new RateLimiter();
  const rule = { limit: 2, windowMs: 10_000 };
  assert.deepEqual(limiter.hit("b", "k", rule, 1_000), { ok: true });
  assert.deepEqual(limiter.hit("b", "k", rule, 2_000), { ok: true });
  assert.deepEqual(limiter.hit("b", "k", rule, 3_000), { ok: false, retryAfterSeconds: 8 });
  // Other keys / buckets are independent.
  assert.deepEqual(limiter.hit("b", "other", rule, 3_000), { ok: true });
  assert.deepEqual(limiter.hit("b2", "k", rule, 3_000), { ok: true });
  // Window rolls over.
  assert.deepEqual(limiter.hit("b", "k", rule, 11_001), { ok: true });
});

test("RateLimiter bounds memory when flooded with distinct keys", () => {
  const limiter = new RateLimiter({ maxKeys: 50 });
  const rule = { limit: 1, windowMs: 60_000 };
  for (let i = 0; i < 500; i++) limiter.hit("b", `ip-${i}`, rule, 1_000);
  assert.ok(limiter.size <= 50, `size ${limiter.size}`);
});

test("clientIp ignores X-Forwarded-For unless trustProxy is on", () => {
  const req = {
    headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.9" },
    socket: { remoteAddress: "10.0.0.1" },
  } as never;
  assert.equal(clientIp(req, false), "10.0.0.1");
  assert.equal(clientIp(req, true), "203.0.113.9");
});

// ------------------------------------------------------------ email start 429

test("email start is rate limited per IP with Retry-After", async () => {
  const sent: LoginCodeMessage[] = [];
  await withApp(
    async (base) => {
      for (const n of [1, 2]) {
        const ok = await fetch(`${base}/v1/auth/email/start`, json({ email: `u${n}@cornell.edu` }));
        assert.equal(ok.status, 200);
      }
      const blocked = await fetch(`${base}/v1/auth/email/start`, json({ email: "u3@cornell.edu" }));
      assert.equal(blocked.status, 429);
      assert.ok(Number(blocked.headers.get("retry-after")) >= 1);
      const body = (await blocked.json()) as { error: { code: string } };
      assert.equal(body.error.code, "rate_limited");
      assert.equal(sent.length, 2);
    },
    {
      mailer: captureMailer(sent),
      rateRules: { emailStartIp: { limit: 2, windowMs: 60_000 } },
    },
  );
});

test("email start is rate limited per mailbox (inbox bombing)", async () => {
  const sent: LoginCodeMessage[] = [];
  await withApp(
    async (base) => {
      assert.equal((await fetch(`${base}/v1/auth/email/start`, json({ email: "v@cornell.edu" }))).status, 200);
      assert.equal((await fetch(`${base}/v1/auth/email/start`, json({ email: "V@Cornell.edu" }))).status, 200);
      const blocked = await fetch(`${base}/v1/auth/email/start`, json({ email: "v@cornell.edu" }));
      assert.equal(blocked.status, 429);
      // A different mailbox is unaffected.
      assert.equal((await fetch(`${base}/v1/auth/email/start`, json({ email: "w@cornell.edu" }))).status, 200);
      assert.equal(sent.length, 3);
    },
    {
      mailer: captureMailer(sent),
      rateRules: { emailStartEmail: { limit: 2, windowMs: 60_000 } },
    },
  );
});

test("email verify is rate limited per IP", async () => {
  await withApp(
    async (base) => {
      const attempt = () =>
        fetch(`${base}/v1/auth/email/verify`, json({ email: "a@cornell.edu", code: "123456" }));
      assert.equal((await attempt()).status, 401);
      assert.equal((await attempt()).status, 401);
      assert.equal((await attempt()).status, 429);
    },
    { rateRules: { emailVerifyIp: { limit: 2, windowMs: 60_000 } } },
  );
});

// ---------------------------------------------------------------- OTP lockout

test("OTP lockout: 5 wrong codes lock the mailbox, even for the correct code", async () => {
  const sent: LoginCodeMessage[] = [];
  let nowMs = Date.parse("2026-10-03T12:00:00Z");
  await withApp(
    async (base) => {
      await fetch(`${base}/v1/auth/email/start`, json({ email: "lock@cornell.edu" }));
      const real = sent[0]?.code ?? "";
      assert.match(real, /^\d{6}$/);
      const wrong = real === "000000" ? "000001" : "000000";
      const verify = (code: string) =>
        fetch(`${base}/v1/auth/email/verify`, json({ email: "lock@cornell.edu", code }));

      for (let i = 0; i < 4; i++) {
        const res = await verify(wrong);
        assert.equal(res.status, 401, `attempt ${i + 1}`);
      }
      const fifth = await verify(wrong);
      assert.equal(fifth.status, 429);
      assert.ok(Number(fifth.headers.get("retry-after")) > 0);
      assert.equal(((await fifth.json()) as { error: { code: string } }).error.code, "otp_locked");

      // The real code is refused while locked.
      const locked = await verify(real);
      assert.equal(locked.status, 429);

      // Another mailbox is unaffected.
      await fetch(`${base}/v1/auth/email/start`, json({ email: "free@cornell.edu" }));
      const other = await fetch(
        `${base}/v1/auth/email/verify`,
        json({ email: "free@cornell.edu", code: sent[1]?.code }),
      );
      assert.equal(other.status, 200);

      // After the lockout lapses a fresh code works again.
      nowMs += 16 * 60_000;
      const restart = await fetch(`${base}/v1/auth/email/start`, json({ email: "lock@cornell.edu" }));
      assert.equal(restart.status, 200);
      const ok = await verify(sent[2]?.code ?? "");
      assert.equal(ok.status, 200);
    },
    { mailer: captureMailer(sent), now: () => new Date(nowMs) },
  );
});

test("OTP lockout: a successful verify resets the failure count", async () => {
  const sent: LoginCodeMessage[] = [];
  await withApp(
    async (base) => {
      await fetch(`${base}/v1/auth/email/start`, json({ email: "reset@cornell.edu" }));
      const real = sent[0]?.code ?? "";
      const wrong = real === "000000" ? "000001" : "000000";
      const verify = (code: string) =>
        fetch(`${base}/v1/auth/email/verify`, json({ email: "reset@cornell.edu", code }));
      for (let i = 0; i < 2; i++) assert.equal((await verify(wrong)).status, 401);
      assert.equal((await verify(real)).status, 200);
      // Fresh code, and the earlier two failures no longer count.
      await fetch(`${base}/v1/auth/email/start`, json({ email: "reset@cornell.edu" }));
      for (let i = 0; i < 2; i++) assert.equal((await verify(wrong)).status, 401);
      assert.equal((await verify(sent[1]?.code ?? "")).status, 200);
    },
    {
      mailer: captureMailer(sent),
      emailCodeGuard: new EmailCodeGuard({ maxFailures: 3 }),
    },
  );
});

test("EmailCodeGuard unit: failure window expires old failures", () => {
  const guard = new EmailCodeGuard({ maxFailures: 3, failureWindowMs: 1_000, lockoutMs: 5_000 });
  assert.equal(guard.recordFailure("a@b.co", 0), false);
  assert.equal(guard.recordFailure("a@b.co", 100), false);
  // Third failure arrives after the window → counted as the first of a new window.
  assert.equal(guard.recordFailure("a@b.co", 2_000), false);
  assert.equal(guard.lockedForSeconds("a@b.co", 2_000), 0);
  assert.equal(guard.recordFailure("a@b.co", 2_100), false);
  assert.equal(guard.recordFailure("a@b.co", 2_200), true);
  assert.equal(guard.lockedForSeconds("a@b.co", 2_300), 5);
  assert.equal(guard.lockedForSeconds("a@b.co", 7_300), 0);
});

// ------------------------------------------------------- production w/o SMTP

test("production refuses email auth when SMTP is not configured", async () => {
  await withApp(
    async (base) => {
      const res = await fetch(`${base}/v1/auth/email/start`, json({ email: "prod@cornell.edu" }));
      assert.equal(res.status, 503);
      const body = (await res.json()) as { error: { code: string } };
      assert.equal(body.error.code, "email_not_configured");
    },
    { config: appConfig({ NODE_ENV: "production" }) },
  );
});

// --------------------------------------------------------------- coach / TTS

function tagsFetch(calls: string[]): FetchLike {
  return (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ models: [{ name: "qwen2.5:0.5b" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as FetchLike;
}

test("coach proxy is rate limited per identity", async () => {
  const calls: string[] = [];
  await withApp(
    async (base) => {
      const get = () =>
        fetch(`${base}/v1/coach/api/tags`, { headers: { Authorization: `Bearer ${COACH_TOKEN}` } });
      assert.equal((await get()).status, 200);
      assert.equal((await get()).status, 200);
      const blocked = await get();
      assert.equal(blocked.status, 429);
      assert.ok(Number(blocked.headers.get("retry-after")) >= 1);
      assert.equal(calls.length, 2, "blocked request must not reach Ollama");
    },
    { fetch: tagsFetch(calls), rateRules: { coachUser: { limit: 2, windowMs: 60_000 } } },
  );
});

test("coach pre-auth IP limit throttles token guessing", async () => {
  await withApp(
    async (base) => {
      const bad = () =>
        fetch(`${base}/v1/coach/api/tags`, { headers: { Authorization: "Bearer wrong-token" } });
      assert.equal((await bad()).status, 401);
      assert.equal((await bad()).status, 401);
      assert.equal((await bad()).status, 429);
    },
    { rateRules: { coachIp: { limit: 2, windowMs: 60_000 } } },
  );
});

test("TTS is rate limited per identity before any synthesis", async () => {
  let upstream = 0;
  await withApp(
    async (base) => {
      const speak = () =>
        fetch(`${base}/v1/voice/tts`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${COACH_TOKEN}` },
          body: JSON.stringify({ text: "Back to work" }),
        });
      const first = await speak();
      assert.notEqual(first.status, 429);
      const second = await speak();
      assert.equal(second.status, 429);
      assert.ok(Number(second.headers.get("retry-after")) >= 1);
      assert.equal(upstream, 0);
    },
    {
      // xAI key unset → synthesis never reaches fetch; the point is the 2nd call is cut off first.
      fetch: (async () => {
        upstream += 1;
        throw new Error("unexpected upstream call");
      }) as FetchLike,
      rateRules: { ttsUser: { limit: 1, windowMs: 60_000 } },
    },
  );
});

// ------------------------------------------------------------- model allowlist

test("coach generate only allows configured models", async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify({ response: "ok", done: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as FetchLike;

  await withApp(
    async (base) => {
      const generate = (body: unknown) =>
        fetch(`${base}/v1/coach/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${COACH_TOKEN}` },
          body: JSON.stringify(body),
        });

      for (const model of ["qwen2.5:0.5b", "moondream", "moondream:latest", "qwen2.5:7b", "custom:1b"]) {
        const res = await generate({ model, prompt: "hi" });
        assert.equal(res.status, 200, model);
      }
      assert.equal(calls.length, 5);

      const before = calls.length;
      for (const model of ["llama3.1:405b", "qwen2.5:72b", "../etc/passwd"]) {
        const res = await generate({ model, prompt: "hi" });
        assert.equal(res.status, 403, model);
        assert.equal(((await res.json()) as { error: { code: string } }).error.code, "model_not_allowed");
      }
      const missing = await generate({ prompt: "hi" });
      assert.equal(missing.status, 400);
      const nonString = await generate({ model: ["qwen2.5:0.5b"], prompt: "hi" });
      assert.equal(nonString.status, 400);
      assert.equal(calls.length, before, "rejected models must never reach Ollama");
    },
    {
      fetch: fetchImpl,
      config: appConfig({ OLLAMA_ALLOWED_MODELS: "custom:1b" }),
    },
  );
});

test("coach generate clamps num_ctx / num_predict and forces stream:false", async () => {
  let forwarded: Record<string, unknown> = {};
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    forwarded = JSON.parse(String(init?.body ?? "{}"));
    return new Response(JSON.stringify({ response: "ok", done: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as FetchLike;
  await withApp(
    async (base) => {
      const res = await fetch(`${base}/v1/coach/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${COACH_TOKEN}` },
        body: JSON.stringify({
          model: "qwen2.5:0.5b",
          prompt: "hi",
          stream: true,
          options: { num_ctx: 1_000_000, num_predict: 999_999, temperature: 0.2 },
        }),
      });
      assert.equal(res.status, 200);
      assert.equal(forwarded.stream, false);
      assert.deepEqual(forwarded.options, { num_ctx: 16384, num_predict: 4096, temperature: 0.2 });
    },
    { fetch: fetchImpl },
  );
});

// ------------------------------------------------------------ anonymous status

function statusFetch(hits: { gemini: number; ollama: number }): FetchLike {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("generativelanguage.googleapis.com")) {
      hits.gemini += 1;
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    }
    if (url.includes("/api/tags")) {
      hits.ollama += 1;
      return new Response(
        JSON.stringify({ models: [{ name: "qwen2.5:0.5b" }, { name: "qwen2.5:7b" }] }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as FetchLike;
}

test("anonymous GET /v1/status is config-only (no Gemini or Ollama probe)", async () => {
  const hits = { gemini: 0, ollama: 0 };
  await withApp(
    async (base) => {
      for (let i = 0; i < 3; i++) {
        const res = await fetch(`${base}/v1/status`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as StatusResponse;
        const gemini = body.services.find((s) => s.id === "gemini");
        assert.equal(gemini?.status, "Configured");
        assert.equal(gemini?.state, "ok");
        assert.equal(body.services.find((s) => s.id === "ollama")?.status, "Configured");
        assert.equal(body.services.find((s) => s.id === "account")?.state, "warn");
      }
      assert.deepEqual(hits, { gemini: 0, ollama: 0 });
    },
    { fetch: statusFetch(hits) },
  );
});

test("anonymous status still reports a missing Gemini key", async () => {
  const hits = { gemini: 0, ollama: 0 };
  await withApp(
    async (base) => {
      const body = (await (await fetch(`${base}/v1/status`)).json()) as StatusResponse;
      const gemini = body.services.find((s) => s.id === "gemini");
      assert.equal(gemini?.state, "err");
      assert.match(gemini?.detail ?? "", /Cloud coach is not set up/i);
      assert.equal(hits.gemini, 0);
    },
    { fetch: statusFetch(hits), config: appConfig({ GEMINI_API_KEY: "" }) },
  );
});

test("signed-in GET /v1/status runs the live probes", async () => {
  const hits = { gemini: 0, ollama: 0 };
  await withApp(
    async (base) => {
      const access = await signIn(base);
      const res = await fetch(`${base}/v1/status`, { headers: { Authorization: `Bearer ${access}` } });
      const body = (await res.json()) as StatusResponse;
      assert.equal(body.services.find((s) => s.id === "gemini")?.status, "Connected");
      assert.equal(hits.gemini, 1);
      assert.equal(hits.ollama, 1);
    },
    { fetch: statusFetch(hits) },
  );
});

test("GET /v1/status is rate limited per IP", async () => {
  await withApp(
    async (base) => {
      assert.equal((await fetch(`${base}/v1/status`)).status, 200);
      assert.equal((await fetch(`${base}/v1/status`)).status, 200);
      assert.equal((await fetch(`${base}/v1/status`)).status, 429);
    },
    { rateRules: { statusIp: { limit: 2, windowMs: 60_000 } } },
  );
});

// ------------------------------------------------------------- google / chat

test("google start is rate limited per IP", async () => {
  await withApp(
    async (base) => {
      const start = () => fetch(`${base}/v1/auth/google/start`, { method: "POST" });
      assert.equal((await start()).status, 200);
      assert.equal((await start()).status, 429);
    },
    { rateRules: { googleStartIp: { limit: 1, windowMs: 60_000 } } },
  );
});

test("chat accepts bodies up to 256KB and rejects larger with 413", async () => {
  await withApp(async (base) => {
    const access = await signIn(base);
    const chat = (bytes: number) =>
      fetch(`${base}/v1/gemini/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${access}` },
        body: JSON.stringify({ message: "x".repeat(bytes) }),
      });
    const big = await chat(300 * 1024);
    assert.equal(big.status, 413);
    const mid = await chat(100 * 1024);
    assert.notEqual(mid.status, 413, "100KB chat must pass the body cap");
  });
});

test("chat is rate limited per IP", async () => {
  await withApp(
    async (base) => {
      const access = await signIn(base);
      const chat = () =>
        fetch(`${base}/v1/gemini/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${access}` },
          body: JSON.stringify({}),
        });
      assert.notEqual((await chat()).status, 429);
      assert.equal((await chat()).status, 429);
    },
    { rateRules: { chatIp: { limit: 1, windowMs: 60_000 } } },
  );
});
