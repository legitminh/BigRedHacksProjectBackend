import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { CalendarClient } from "../src/calendar/client.ts";
import type { DriveClient } from "../src/drive/client.ts";
import {
  ensureSchoolDigest,
  getManualRefreshStatus,
  MANUAL_REFRESH_COOLDOWN_MS,
} from "../src/drive/schoolDigest.ts";
import { buildCompanionChatSystem } from "../src/companion/geminiLive.ts";
import { HttpError } from "../src/http.ts";
import { openFileStore } from "../src/store/file.ts";

const USER = "11111111-1111-4111-8111-111111111111";

function calendar(): CalendarClient {
  return {
    async refresh() {
      return "access";
    },
    async listEvents() {
      return [];
    },
    async insertEvent() {
      return { id: "e1" };
    },
    async getEvent() {
      return { id: "e1" };
    },
    async patchEvent() {
      return { id: "e1" };
    },
    async deleteEvent() {},
  };
}

function drive(): DriveClient {
  return {
    async listRecent() {
      return [];
    },
    async search() {
      return [];
    },
    async listFolder() {
      return [];
    },
    async findFolders() {
      return [];
    },
    async inventory() {
      return { files: [], nextPageToken: null, truncated: false, folderCount: 0 };
    },
    async readFileText() {
      return { ok: false, reason: "missing" };
    },
  };
}

test("ensureSchoolDigest skips second overview call same digest_date", async () => {
  const dir = await mkdtemp(join(tmpdir(), "waypoint-digest-"));
  const store = openFileStore(join(dir, "store.json"));
  let flashCalls = 0;
  const now = new Date("2026-10-03T18:00:00.000Z");

  const input = {
    drive: drive(),
    calendar: calendar(),
    store,
    userId: USER,
    accessToken: "token",
    timeZone: "America/New_York",
    now,
    geminiApiKey: "key",
    overviewModel: "gemini-3.5-flash",
    generateDigest: async () => {
      flashCalls += 1;
      return "## THIS WEEK\n- HW1 (source: syl.pdf)";
    },
  };

  const first = await ensureSchoolDigest(input);
  const second = await ensureSchoolDigest(input);
  assert.equal(flashCalls, 1);
  assert.equal(first.digestDate, second.digestDate);
  assert.equal(second.digestText, first.digestText);
  assert.equal(first.manualRefreshAt ?? null, null);
});

test("manual refresh is allowed once per 24 hours", async () => {
  const dir = await mkdtemp(join(tmpdir(), "waypoint-digest-manual-"));
  const store = openFileStore(join(dir, "store.json"));
  let flashCalls = 0;
  const now = new Date("2026-10-03T18:00:00.000Z");

  const input = {
    drive: drive(),
    calendar: calendar(),
    store,
    userId: USER,
    accessToken: "token",
    timeZone: "America/New_York",
    now,
    geminiApiKey: "key",
    overviewModel: "gemini-3.5-flash",
    generateDigest: async () => {
      flashCalls += 1;
      return `## THIS WEEK\n- HW call ${flashCalls}`;
    },
  };

  await ensureSchoolDigest(input);
  const forced = await ensureSchoolDigest({ ...input, force: true });
  assert.equal(flashCalls, 2);
  assert.equal(forced.manualRefreshAt, now.toISOString());

  await assert.rejects(
    () => ensureSchoolDigest({ ...input, force: true, now: new Date(now.getTime() + 60_000) }),
    (error: unknown) =>
      error instanceof HttpError &&
      error.status === 429 &&
      error.code === "digest_manual_refresh_cooldown",
  );
  assert.equal(flashCalls, 2);

  const later = new Date(now.getTime() + MANUAL_REFRESH_COOLDOWN_MS + 1);
  const status = await getManualRefreshStatus(store, USER, later);
  assert.equal(status.available, true);
  const again = await ensureSchoolDigest({ ...input, force: true, now: later });
  assert.equal(flashCalls, 3);
  assert.equal(again.manualRefreshAt, later.toISOString());
});

test("buildCompanionChatSystem includes cached school digest", () => {
  const system = buildCompanionChatSystem({
    goals: "study",
    school_digest: "## THIS WEEK\n- Lab due Mon",
    school_digest_date: "2026-10-03",
  });
  assert.match(system, /SCHOOL DIGEST \(generated 2026-10-03\)/);
  assert.match(system, /Lab due Mon/);
});
