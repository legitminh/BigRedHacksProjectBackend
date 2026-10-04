import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { PendingLogins, type CompletedLogin } from "../src/auth/pending.ts";
import { CalendarConnects } from "../src/calendar/connect.ts";
import { loadConfig } from "../src/config.ts";
import { createDriveClient } from "../src/drive/client.ts";
import { HttpError } from "../src/http.ts";
import type { Mailer } from "../src/mailer.ts";
import { createApp } from "../src/server.ts";
import { openFileStore } from "../src/store/file.ts";

const SECRET = "0123456789abcdef0123456789abcdef";

async function withApp(
  fn: (ctx: { base: string; token: string; userId: string; store: ReturnType<typeof openFileStore>; revoked: string[] }) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "waypoint-gtoken-"));
  const inbox: string[] = [];
  const revoked: string[] = [];
  const mailer: Mailer = { async sendLoginCode(m) { inbox.push(m.code); } };
  const store = openFileStore(join(dir, "store.json"));
  const server: Server = createApp({
    config: loadConfig({ GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "s", SESSION_SECRET: SECRET, PUBLIC_BASE_URL: "http://127.0.0.1:8787" }),
    store,
    mailer,
    now: () => new Date("2026-10-03T18:00:00.000Z"),
    fetch: async (input, init) => {
      if (String(input).includes("oauth2.googleapis.com/revoke")) {
        revoked.push(String((init?.body as URLSearchParams).get("token")));
        return new Response("{}", { status: 200 });
      }
      throw new Error(`unexpected fetch ${String(input)}`);
    },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fetch(`${base}/v1/auth/email/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "student@cornell.edu" }),
    });
    const verify = await fetch(`${base}/v1/auth/email/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "student@cornell.edu", code: inbox.at(-1) }),
    });
    const body = (await verify.json()) as { access_token: string; user: { id: string } };
    await fn({ base, token: body.access_token, userId: body.user.id, store, revoked });
  } finally {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  }
}

test("POST /v1/google/disconnect clears both tools and keeps the identity refresh token", async () => {
  await withApp(async ({ base, token, userId, store, revoked }) => {
    await store.setCalendarGrant(userId, "secret-refresh", true);
    assert.equal((await store.getCalendarConnection(userId)).refreshToken, "secret-refresh");

    const res = await fetch(`${base}/v1/google/disconnect`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 204);
    assert.deepEqual(revoked, []);
    assert.deepEqual(await store.getCalendarConnection(userId), { connected: false, refreshToken: "secret-refresh" });
    const tools = await store.listToolConnections(userId);
    assert.equal(tools.length, 2);
    assert.equal(tools.every((tool) => tool.status === "disconnected" && tool.refreshToken === null), true);
  });
});

test("disconnecting calendar keeps a different Drive refresh token", async () => {
  await withApp(async ({ base, token, userId, store, revoked }) => {
    const now = "2026-10-03T18:00:00.000Z";
    await store.setCalendarGrant(userId, "identity-token", false);
    await store.upsertToolConnection(userId, {
      toolId: "google_calendar",
      provider: "google",
      scopes: "https://www.googleapis.com/auth/calendar.events",
      refreshToken: "cal-token",
      status: "connected",
      connectedAt: now,
      updatedAt: now,
    });
    await store.upsertToolConnection(userId, {
      toolId: "google_drive",
      provider: "google",
      scopes: "https://www.googleapis.com/auth/drive.readonly",
      refreshToken: "drive-token",
      status: "connected",
      connectedAt: now,
      updatedAt: now,
    });
    const res = await fetch(`${base}/v1/tools/google_calendar/disconnect`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 204);
    assert.deepEqual(revoked, ["cal-token"]);
    const tools = await store.listToolConnections(userId);
    const calendar = tools.find((tool) => tool.toolId === "google_calendar");
    const drive = tools.find((tool) => tool.toolId === "google_drive");
    assert.equal(calendar?.status, "disconnected");
    assert.equal(calendar?.refreshToken, null);
    assert.equal(drive?.status, "connected");
    assert.equal(drive?.refreshToken, "drive-token");
    assert.equal((await store.getCalendarConnection(userId)).refreshToken, "identity-token");
  });
});

test("legacy calendar_connected user is listed as both tools connected", async () => {
  await withApp(async ({ base, token, userId, store }) => {
    await store.setCalendarGrant(userId, "legacy-refresh", true);
    const res = await fetch(`${base}/v1/tools`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { tools: { id: string; status: string }[] };
    assert.equal(JSON.stringify(body).includes("legacy-refresh"), false);
    assert.equal(body.tools.find((tool) => tool.id === "google_calendar")?.status, "connected");
    assert.equal(body.tools.find((tool) => tool.id === "google_drive")?.status, "connected");
    const status = await fetch(`${base}/v1/google/status`, { headers: { Authorization: `Bearer ${token}` } });
    const flags = (await status.json()) as {
      calendar_connected: boolean;
      drive_connected: boolean;
      google_connected: boolean;
    };
    assert.equal(flags.calendar_connected, true);
    assert.equal(flags.drive_connected, true);
    assert.equal(flags.google_connected, true);
    const rows = await store.listToolConnections(userId);
    assert.equal(rows.length, 2);
    assert.equal(rows.every((tool) => tool.refreshToken === "legacy-refresh" && tool.status === "connected"), true);
    assert.equal((await store.listToolConnections(userId)).length, 2);
  });
});

test("re-login keeps a legacy Calendar grant on the tools and stores a new identity token", async () => {
  await withApp(async ({ userId, store }) => {
    await store.setCalendarGrant(userId, "legacy-refresh", true);
    await store.upsertGoogleUser(
      {
        sub: "google-sub-relogin",
        email: "student@cornell.edu",
        emailVerified: true,
        name: "Student",
        picture: null,
        googleRefreshToken: "identity-refresh",
      },
      new Date("2026-10-03T18:00:00.000Z"),
    );
    const tools = await store.listToolConnections(userId);
    assert.equal(tools.length, 2);
    assert.equal(
      tools.every((tool) => tool.status === "connected" && tool.refreshToken === "legacy-refresh"),
      true,
    );
    assert.equal((await store.getCalendarConnection(userId)).refreshToken, "identity-refresh");
  });
});

test("DELETE /v1/me/data revokes the Google grant before wiping", async () => {
  await withApp(async ({ base, token, userId, store, revoked }) => {
    await store.setCalendarGrant(userId, "wipe-refresh", true);
    const res = await fetch(`${base}/v1/me/data`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 204);
    assert.deepEqual(revoked, ["wipe-refresh"]);
    assert.deepEqual(await store.getCalendarConnection(userId), { connected: false, refreshToken: null });
  });
});

test("completed Google login tokens are never written to the pending file (mode 0600)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "waypoint-pending-"));
  const file = join(dir, "pending-google-logins.json");
  const pending = new PendingLogins(file);
  const now = Date.now();
  const entry = {
    state: "st",
    pollToken: "pt",
    codeVerifier: "cv",
    expiresAt: now + 60_000,
    status: "pending" as const,
  };
  pending.put(entry);
  const claim = pending.claim("st", now);
  assert.ok(claim.ok);
  const result: CompletedLogin = {
    token_type: "Bearer",
    access_token: "PLAINTEXT-ACCESS",
    refresh_token: "PLAINTEXT-REFRESH",
    expires_in: 900,
    user: { id: "u", email: null, email_verified: false, name: null, picture: null, calendar_connected: false } as never,
  };
  pending.complete(claim.ok ? claim.pending : entry, result);

  const raw = await readFile(file, "utf8");
  assert.ok(!raw.includes("PLAINTEXT-ACCESS"));
  assert.ok(!raw.includes("PLAINTEXT-REFRESH"));
  assert.equal((await stat(file)).mode & 0o777, 0o600);

  // Still deliverable from memory.
  const polled = pending.poll("pt", now);
  assert.equal(polled.type, "complete");
});

test("PendingLogins.claim is single-flight and poll stays pending while exchanging", () => {
  const pending = new PendingLogins();
  const now = Date.now();
  pending.put({ state: "s", pollToken: "p", codeVerifier: "v", expiresAt: now + 60_000, status: "pending" });
  assert.ok(pending.claim("s", now).ok);
  const second = pending.claim("s", now);
  assert.deepEqual(second, { ok: false, reason: "used" });
  assert.equal(pending.poll("p", now).type, "pending");
});

test("CalendarConnects.claim is single-flight", () => {
  const connects = new CalendarConnects();
  const now = Date.now();
  connects.put({
    state: "s",
    pollToken: "p",
    codeVerifier: "v",
    userId: "u",
    toolId: "google_calendar",
    expiresAt: now + 60_000,
    status: "pending",
  });
  assert.equal(connects.claim("s", now).ok, true);
  assert.equal(connects.claim("s", now).ok, false);
  assert.equal(connects.poll("p", now).type, "pending");
});

test("Drive client maps upstream failures to HttpError 502", async () => {
  const drive = createDriveClient((async () => new Response("no", { status: 403 })) as typeof fetch);
  await assert.rejects(
    () => drive.listRecent("tok", 5),
    (e: unknown) => e instanceof HttpError && e.status === 502 && !String((e as Error).message).includes("tok"),
  );
  await assert.rejects(() => drive.search("tok", "notes", 5), (e: unknown) => e instanceof HttpError);
});
