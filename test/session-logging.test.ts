import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { GoogleClient } from "../src/auth/google.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { createApp } from "../src/server.ts";
import { openFileStore } from "../src/store/file.ts";

const SESSION_SECRET = "0123456789abcdef0123456789abcdef";
const STARTED = new Date("2026-10-03T16:00:00.000Z");

function readyConfig(): Config {
  return loadConfig({
    GOOGLE_CLIENT_ID: "client-id.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "client-secret",
    SESSION_SECRET,
    PUBLIC_BASE_URL: "http://127.0.0.1:8787",
    ACCESS_TOKEN_TTL_SECONDS: "900",
  });
}

function plus(seconds: number): string {
  return new Date(STARTED.getTime() + seconds * 1000).toISOString();
}

function rotatingGoogle(): GoogleClient {
  const people = [
    { sub: "google-sub-1", email: "one@cornell.edu" },
    { sub: "google-sub-2", email: "two@cornell.edu" },
  ];
  let index = 0;
  return {
    async exchangeCode() {
      return { accessToken: "google-access", refreshToken: "google-refresh" };
    },
    async fetchUserInfo() {
      const person = people[index] ?? people[0]!;
      index += 1;
      return {
        sub: person.sub,
        email: person.email,
        emailVerified: true,
        name: person.email,
        picture: null,
      };
    },
  };
}

async function withApp(
  fn: (base: string, storePath: string) => Promise<void>,
  options: { now?: () => Date } = {},
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "waypoint-sessions-"));
  const storePath = join(dir, "store.json");
  const store = openFileStore(storePath);
  const server: Server = createApp({
    config: readyConfig(),
    store,
    google: rotatingGoogle(),
    now: options.now ?? (() => STARTED),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${address.port}`, storePath);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await store.close();
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
  const body = (await poll.json()) as { status: string; access_token: string };
  assert.equal(body.status, "complete");
  return body.access_token;
}

function authHeaders(token: string, json = false): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

type ErrorBody = { error: { code: string; message: string } };

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as ErrorBody;
  return body.error.code;
}

test("session routes require a bearer token", async () => {
  await withApp(async (base) => {
    const paths = [
      { method: "POST", path: "/v1/sessions" },
      { method: "GET", path: "/v1/sessions" },
      { method: "GET", path: "/v1/sessions/missing" },
      { method: "GET", path: "/v1/sessions/missing/summary" },
      { method: "POST", path: "/v1/sessions/missing/events" },
    ];
    for (const item of paths) {
      const response = await fetch(`${base}${item.path}`, { method: item.method });
      assert.equal(response.status, 401);
      assert.equal(await errorCode(response), "unauthorized");
    }
  });
});

test("creates a session, appends focus and break events, and summarizes them", async () => {
  let now = STARTED;
  await withApp(
    async (base, storePath) => {
      const token = await accessToken(base);
      const created = await fetch(`${base}/v1/sessions`, {
        method: "POST",
        headers: authHeaders(token, true),
        body: JSON.stringify({
          goals: "  Finish the problem set  ",
          duration_secs: 1500,
          modality: "pomodoro",
        }),
      });
      assert.equal(created.status, 201);
      const session = (await created.json()) as {
        id: string;
        goals: string;
        duration_secs: number;
        modality: string;
        started_at: string;
      };
      assert.equal(session.goals, "Finish the problem set");
      assert.equal(session.duration_secs, 1500);
      assert.equal(session.modality, "pomodoro");
      assert.equal(session.started_at, STARTED.toISOString());

      const events = [
        { type: "focus_sample", at: plus(100), payload: { focus: 0.8 } },
        { type: "break_started", at: plus(200) },
        { type: "break_ended", at: plus(260) },
        { type: "focus_sample", at: plus(400), payload: { focus: 0.4 } },
        { type: "session_ended", at: plus(600) },
      ];
      for (const event of events) {
        const response = await fetch(`${base}/v1/sessions/${session.id}/events`, {
          method: "POST",
          headers: authHeaders(token, true),
          body: JSON.stringify(event),
        });
        assert.equal(response.status, 201);
        const body = (await response.json()) as { id: string; type: string; at: string };
        assert.equal(body.type, event.type);
        assert.equal(body.at, event.at);
        assert.equal(typeof body.id, "string");
      }

      const omittedAt = await fetch(`${base}/v1/sessions/${session.id}/events`, {
        method: "POST",
        headers: authHeaders(token, true),
        body: JSON.stringify({ type: "coach_spoke", payload: { text: "stay with it" } }),
      });
      assert.equal(omittedAt.status, 201);
      const spoken = (await omittedAt.json()) as { at: string };
      assert.equal(spoken.at, STARTED.toISOString());

      const detail = await fetch(`${base}/v1/sessions/${session.id}`, {
        headers: authHeaders(token),
      });
      assert.equal(detail.status, 200);
      const stored = (await detail.json()) as {
        ended_at: string;
        events: { type: string; at: string; payload: { focus?: number } }[];
      };
      assert.equal(stored.ended_at, plus(600));
      assert.deepEqual(
        stored.events.map((event) => event.type),
        ["coach_spoke", "focus_sample", "break_started", "break_ended", "focus_sample", "session_ended"],
      );
      assert.equal(stored.events[1]?.payload.focus, 0.8);

      const summary = await fetch(`${base}/v1/sessions/${session.id}/summary`, {
        headers: authHeaders(token),
      });
      assert.equal(summary.status, 200);
      assert.deepEqual(await summary.json(), {
        session_id: session.id,
        goals: "Finish the problem set",
        time_spent_secs: 540,
        break_secs: 60,
        attention_level: 0.6,
        event_count: 6,
      });

      now = new Date(STARTED.getTime() + 1000);
      const later = await fetch(`${base}/v1/sessions`, {
        method: "POST",
        headers: authHeaders(token, true),
        body: JSON.stringify({ goals: "Review notes", duration_secs: 600, modality: "review" }),
      });
      assert.equal(later.status, 201);
      const second = (await later.json()) as { id: string; started_at: string };
      assert.equal(second.started_at, now.toISOString());

      const list = await fetch(`${base}/v1/sessions`, { headers: authHeaders(token) });
      assert.equal(list.status, 200);
      const listed = (await list.json()) as {
        sessions: {
          id: string;
          started_at: string;
          session_id: string;
          time_spent_secs: number;
          break_secs: number;
          attention_level: number | null;
        }[];
      };
      assert.deepEqual(
        listed.sessions.map((item) => item.id),
        [second.id, session.id],
      );
      assert.equal(listed.sessions[0]?.started_at, second.started_at);
      assert.equal(listed.sessions[1]?.session_id, session.id);
      assert.equal(listed.sessions[1]?.time_spent_secs, 540);
      assert.equal(listed.sessions[1]?.break_secs, 60);
      assert.equal(listed.sessions[1]?.attention_level, 0.6);

      const file = JSON.parse(await readFile(storePath, "utf8")) as {
        studySessions: { id: string; user_id: string; ended_at: string | null }[];
        sessionEvents: { type: string; at: string }[];
      };
      assert.equal(file.studySessions.length, 2);
      assert.equal(file.studySessions.find((item) => item.id === session.id)?.ended_at, plus(600));
      assert.equal(file.sessionEvents.length, 6);
    },
    { now: () => now },
  );
});

test("an open break runs until now when the session has not ended", async () => {
  let now = STARTED;
  await withApp(
    async (base) => {
      const token = await accessToken(base);
      const created = await fetch(`${base}/v1/sessions`, {
        method: "POST",
        headers: authHeaders(token, true),
        body: JSON.stringify({ goals: "Read chapter 3", duration_secs: 900, modality: "read" }),
      });
      const session = (await created.json()) as { id: string };
      await fetch(`${base}/v1/sessions/${session.id}/events`, {
        method: "POST",
        headers: authHeaders(token, true),
        body: JSON.stringify({ type: "break_started", at: plus(10) }),
      });
      now = new Date(STARTED.getTime() + 70_000);
      const summary = await fetch(`${base}/v1/sessions/${session.id}/summary`, {
        headers: authHeaders(token),
      });
      assert.equal(summary.status, 200);
      const body = (await summary.json()) as {
        time_spent_secs: number;
        break_secs: number;
        attention_level: number | null;
        event_count: number;
      };
      assert.equal(body.time_spent_secs, 10);
      assert.equal(body.break_secs, 60);
      assert.equal(body.attention_level, null);
      assert.equal(body.event_count, 1);
    },
    { now: () => now },
  );
});

test("another user cannot read the session", async () => {
  await withApp(async (base) => {
    const owner = await accessToken(base);
    const created = await fetch(`${base}/v1/sessions`, {
      method: "POST",
      headers: authHeaders(owner, true),
      body: JSON.stringify({ goals: "Practice proofs", duration_secs: 1200, modality: "focus" }),
    });
    const session = (await created.json()) as { id: string };
    const intruder = await accessToken(base);

    const detail = await fetch(`${base}/v1/sessions/${session.id}`, {
      headers: authHeaders(intruder),
    });
    assert.equal(detail.status, 404);
    assert.equal(await errorCode(detail), "session_not_found");

    const summary = await fetch(`${base}/v1/sessions/${session.id}/summary`, {
      headers: authHeaders(intruder),
    });
    assert.equal(summary.status, 404);
    assert.equal(await errorCode(summary), "session_not_found");

    const event = await fetch(`${base}/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: authHeaders(intruder, true),
      body: JSON.stringify({ type: "distraction" }),
    });
    assert.equal(event.status, 404);
    assert.equal(await errorCode(event), "session_not_found");

    const list = await fetch(`${base}/v1/sessions`, { headers: authHeaders(intruder) });
    const body = (await list.json()) as { sessions: unknown[] };
    assert.deepEqual(body.sessions, []);

    const missing = await fetch(`${base}/v1/sessions/00000000-0000-0000-0000-000000000000`, {
      headers: authHeaders(owner),
    });
    assert.equal(missing.status, 404);
    assert.equal(await errorCode(missing), "session_not_found");
  });
});

test("rejects an invalid session and an invalid event", async () => {
  await withApp(async (base) => {
    const token = await accessToken(base);
    const cases = [
      { goals: "", duration_secs: 600, modality: "focus" },
      { goals: "Read", modality: "focus" },
      { goals: "Read", duration_secs: 0, modality: "focus" },
      { goals: "Read", duration_secs: -5, modality: "focus" },
    ];
    for (const body of cases) {
      const response = await fetch(`${base}/v1/sessions`, {
        method: "POST",
        headers: authHeaders(token, true),
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400);
      assert.equal(await errorCode(response), "invalid_session");
    }

    const created = await fetch(`${base}/v1/sessions`, {
      method: "POST",
      headers: authHeaders(token, true),
      body: JSON.stringify({ goals: "Read", duration_secs: 600, modality: "focus" }),
    });
    const session = (await created.json()) as { id: string };
    const events = [
      { type: "nap" },
      { type: "focus_sample", payload: { focus: 1.2 } },
      { type: "focus_sample", payload: { focus: -0.1 } },
      { type: "distraction", at: "not-a-date" },
    ];
    for (const body of events) {
      const response = await fetch(`${base}/v1/sessions/${session.id}/events`, {
        method: "POST",
        headers: authHeaders(token, true),
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400);
      assert.equal(await errorCode(response), "invalid_event");
    }
  });
});
