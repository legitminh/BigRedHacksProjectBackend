import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { GoogleClient } from "../src/auth/google.ts";
import type { CalendarClient } from "../src/calendar/client.ts";
import type { RawEvent } from "../src/calendar/classify.ts";
import { loadConfig } from "../src/config.ts";
import type { Mailer } from "../src/mailer.ts";
import { createApp } from "../src/server.ts";
import { openFileStore } from "../src/store/file.ts";

const SECRET = "0123456789abcdef0123456789abcdef";

function google(): GoogleClient {
  return {
    async exchangeCode(input) {
      assert.equal(input.redirectUri, "http://127.0.0.1:8787/v1/google/calendar/callback");
      return { accessToken: "google-access", refreshToken: "calendar-refresh" };
    },
    async fetchUserInfo() {
      return { sub: "sub", email: "a@b.c", emailVerified: true, name: "A", picture: null };
    },
  };
}

function calendar(events: RawEvent[], inserted: unknown[] = []): CalendarClient {
  return {
    async refresh() {
      return "access";
    },
    async listEvents() {
      return events;
    },
    async insertEvent(_token, body) {
      inserted.push(body);
      return {
        id: "evt-1",
        htmlLink: "https://calendar.google.com/event?eid=evt-1",
        ...(body as RawEvent),
        summary: (body as { summary?: string }).summary,
      };
    },
    async getEvent() {
      return { id: "class", summary: "Lecture", start: { dateTime: "2026-10-03T15:00:00Z" }, end: { dateTime: "2026-10-03T16:00:00Z" } };
    },
    async patchEvent() {
      return { id: "evt-1", summary: "Study" };
    },
    async deleteEvent() {},
  };
}

async function withApp(fn: (base: string, inbox: { code: string }[]) => Promise<void>, calendarClient = calendar([])) {
  const dir = await mkdtemp(join(tmpdir(), "waypoint-product-"));
  const sent: { code: string }[] = [];
  const mailer: Mailer = { async sendLoginCode(message) { sent.push({ code: message.code }); } };
  const server: Server = createApp({
    config: loadConfig({
      GOOGLE_CLIENT_ID: "client-id",
      GOOGLE_CLIENT_SECRET: "client-secret",
      SESSION_SECRET: SECRET,
      PUBLIC_BASE_URL: "http://127.0.0.1:8787",
    }),
    store: openFileStore(join(dir, "store.json")),
    google: google(),
    mailer,
    calendar: calendarClient,
    now: () => new Date("2026-10-03T18:00:00.000Z"),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${address.port}`, sent);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  return sent;
}

async function tokenFor(base: string, inbox: { code: string }[]): Promise<string> {
  const start = await fetch(`${base}/v1/auth/email/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "student@cornell.edu" }),
  });
  assert.equal(start.status, 200);
  const code = inbox.at(-1)?.code;
  assert.ok(code);
  const verify = await fetch(`${base}/v1/auth/email/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "student@cornell.edu", code }),
  });
  assert.equal(verify.status, 200);
  const body = (await verify.json()) as { access_token: string };
  return body.access_token;
}

test("memory starts empty, updates in place, and caps lists", async () => {
  await withApp(async (base, inbox) => {
    const token = await tokenFor(base, inbox);
    const empty = await fetch(`${base}/v1/memory`, { headers: { Authorization: `Bearer ${token}` } });
    const card = (await empty.json()) as { interests: string[]; interaction: { default_mode: string }; updated_at: string | null };
    assert.deepEqual(card.interests, []);
    assert.equal(card.interaction.default_mode, "advise");
    assert.equal(card.updated_at, null);

    const put = await fetch(`${base}/v1/memory`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        interests: ["distributed systems"],
        proficiencies: [{ topic: "heaps", level: "learning" }],
        interaction: { default_mode: "pair" },
      }),
    });
    assert.equal(put.status, 200);
    const saved = (await put.json()) as {
      interests: string[];
      proficiencies: { topic: string; level: string }[];
      interaction: { default_mode: string; tone: string };
    };
    assert.deepEqual(saved.interests, ["distributed systems"]);
    assert.equal(saved.proficiencies[0]?.level, "learning");
    assert.equal(saved.interaction.default_mode, "pair");
    assert.equal(saved.interaction.tone, "brief");

    const tooMany = await fetch(`${base}/v1/memory`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ interests: Array.from({ length: 13 }, (_, i) => `topic ${i}`) }),
    });
    assert.equal(tooMany.status, 400);
    assert.equal(((await tooMany.json()) as { error: { code: string } }).error.code, "memory_too_large");
  });
});

test("pace median uses the last eight finished samples and proficiency moves one step", async () => {
  await withApp(async (base, inbox) => {
    const token = await tokenFor(base, inbox);
    const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    for (let i = 1; i <= 9; i += 1) {
      const response = await fetch(`${base}/v1/memory/pace`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          topic: i === 9 ? "Heaps" : "heaps",
          problem: `p${i}`,
          planned_minutes: 30,
          actual_minutes: i * 10,
          outcome: i === 1 ? "abandoned" : "finished",
        }),
      });
      assert.equal(response.status, 201);
    }
    const memory = (await (await fetch(`${base}/v1/memory`, { headers: auth })).json()) as {
      pace: { topic: string; median_minutes: number; samples: number }[];
    };
    assert.equal(memory.pace[0]?.topic.toLowerCase(), "heaps");
    assert.equal(memory.pace[0]?.samples, 8);
    assert.equal(memory.pace[0]?.median_minutes, 55);

    const jump = await fetch(`${base}/v1/memory/proficiency`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ topic: "heaps", level: "strong" }),
    });
    assert.equal(jump.status, 409);
    const step = await fetch(`${base}/v1/memory/proficiency`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ topic: "heaps", level: "learning" }),
    });
    assert.equal(step.status, 200);
  });
});

test("tasks replace the active one and completion records pace", async () => {
  await withApp(async (base, inbox) => {
    const token = await tokenFor(base, inbox);
    const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const first = await fetch(`${base}/v1/tasks`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ title: "Problem 2", mode: "advise", planned_minutes: 20 }),
    });
    assert.equal(first.status, 201);
    const second = await fetch(`${base}/v1/tasks`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ title: "Problem 3", mode: "pair", planned_minutes: 30 }),
    });
    const created = (await second.json()) as { id: string; started_at: string };
    const patched = await fetch(`${base}/v1/tasks/${created.id}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ mode: "advise" }),
    });
    const afterPatch = (await patched.json()) as { mode: string; started_at: string };
    assert.equal(afterPatch.mode, "advise");
    assert.equal(afterPatch.started_at, created.started_at);

    const done = await fetch(`${base}/v1/tasks/${created.id}/complete`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ outcome: "finished", topic: "heaps", break_minutes: 0 }),
    });
    assert.equal(done.status, 200);
    const body = (await done.json()) as { task: { status: string }; pace: { actual_minutes: number; problem: string } };
    assert.equal(body.task.status, "done");
    assert.equal(body.pace.problem, "Problem 3");
    assert.equal(body.pace.actual_minutes, 1);

    const active = await fetch(`${base}/v1/tasks/active`, { headers: auth });
    assert.equal(active.status, 404);
  });
});

test("session recap is stored for the signed-in user", async () => {
  await withApp(async (base, inbox) => {
    const token = await tokenFor(base, inbox);
    const created = await fetch(`${base}/v1/sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        task_id: "task-1",
        started_at: "2026-10-03T18:30:00Z",
        ended_at: "2026-10-03T19:00:00Z",
        break_minutes: 0,
        attention: "recovered",
        note: "Finished the priority queue.",
      }),
    });
    assert.equal(created.status, 201);
    const list = await fetch(`${base}/v1/sessions`, { headers: { Authorization: `Bearer ${token}` } });
    const body = (await list.json()) as { sessions: { attention: string }[] };
    assert.equal(body.sessions[0]?.attention, "recovered");
  });
});

test("calendar consent classifies the agenda and refuses edits to other events", async () => {
  const events: RawEvent[] = [
    { id: "due", summary: "CS 4820 HW3 due", start: { date: "2026-10-06" }, end: { date: "2026-10-07" } },
    {
      id: "block",
      summary: "Study: priority queues",
      start: { dateTime: "2026-10-03T19:00:00-04:00" },
      end: { dateTime: "2026-10-03T19:40:00-04:00" },
      extendedProperties: { private: { waypoint: "1" } },
    },
  ];
  const inserted: unknown[] = [];
  await withApp(async (base, inbox) => {
    const token = await tokenFor(base, inbox);
    const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const blocked = await fetch(`${base}/v1/calendar/agenda`, { headers: auth });
    assert.equal(blocked.status, 409);

    const start = await fetch(`${base}/v1/google/calendar/start`, { method: "POST", headers: auth });
    assert.equal(start.status, 200);
    const started = (await start.json()) as { authorization_url: string; state: string; poll_token: string };
    const authUrl = new URL(started.authorization_url);
    assert.equal(authUrl.searchParams.get("scope"), "https://www.googleapis.com/auth/calendar.events");
    assert.equal(authUrl.searchParams.get("include_granted_scopes"), "true");
    const callback = await fetch(
      `${base}/v1/google/calendar/callback?code=abc&state=${encodeURIComponent(started.state)}`,
    );
    assert.equal(callback.status, 200);
    const poll = await fetch(`${base}/v1/google/calendar/poll?poll_token=${encodeURIComponent(started.poll_token)}`);
    assert.deepEqual(await poll.json(), { status: "complete", calendar_connected: true });

    const agenda = await fetch(`${base}/v1/calendar/agenda?days=14`, { headers: auth });
    const classified = (await agenda.json()) as {
      deadlines: { title: string }[];
      blocks: { title: string; waypoint: boolean }[];
    };
    assert.equal(classified.deadlines[0]?.title, "CS 4820 HW3 due");
    assert.equal(classified.blocks[0]?.waypoint, true);

    const create = await fetch(`${base}/v1/calendar/events`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        title: "Study: priority queues",
        kind: "study_block",
        start: "2026-10-03T19:00:00-04:00",
        end: "2026-10-03T19:40:00-04:00",
      }),
    });
    assert.equal(create.status, 201);
    const created = (await create.json()) as { waypoint: boolean; html_link: string };
    assert.equal(created.waypoint, true);
    assert.match(created.html_link, /calendar\.google\.com/);
    assert.equal((inserted[0] as { extendedProperties: { private: { waypoint: string } } }).extendedProperties.private.waypoint, "1");

    const patch = await fetch(`${base}/v1/calendar/events/class`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ start: "2026-10-03T19:00:00Z", end: "2026-10-03T19:30:00Z" }),
    });
    assert.equal(patch.status, 403);
    assert.equal(((await patch.json()) as { error: { code: string } }).error.code, "not_waypoint_event");
  }, calendar(events, inserted));
});
