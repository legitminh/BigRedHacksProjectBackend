import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadConfig, type Config } from "../src/config.ts";
import { createApp } from "../src/server.ts";
import { openFileStore } from "../src/store/file.ts";

const SESSION_SECRET = "0123456789abcdef0123456789abcdef";
const ADMIN_PASSWORD = "AdminTestPassword9xK2mQ";

function appConfig(extra: Record<string, string> = {}): Config {
  return loadConfig({
    SESSION_SECRET,
    PUBLIC_BASE_URL: "http://127.0.0.1:8787",
    ADMIN_PASSWORD,
    ...extra,
  });
}

async function withApp(
  fn: (base: string) => Promise<void>,
  options: { config?: Config } = {},
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "waypoint-admin-"));
  const store = openFileStore(join(dir, "store.json"));
  const server: Server = createApp({
    config: options.config ?? appConfig(),
    store,
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

test("GET /admin shows login when configured", async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/admin`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Admin password/);
    assert.doesNotMatch(html, /Recent users/);
  });
});

test("wrong password is rejected", async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "password=nope",
      redirect: "manual",
    });
    assert.equal(res.status, 401);
    assert.match(await res.text(), /Incorrect password/);
  });
});

test("correct password sets cookie and opens dashboard", async () => {
  await withApp(async (base) => {
    const login = await fetch(`${base}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `password=${encodeURIComponent(ADMIN_PASSWORD)}`,
      redirect: "manual",
    });
    assert.equal(login.status, 303);
    const setCookie = login.headers.getSetCookie?.() ?? [];
    const cookieHeader =
      setCookie.find((c) => c.startsWith("wp_admin=")) ??
      login.headers.get("set-cookie") ??
      "";
    assert.match(cookieHeader, /wp_admin=/);
    const cookie = cookieHeader.split(";")[0];

    const dash = await fetch(`${base}/admin`, {
      headers: { Cookie: cookie },
    });
    assert.equal(dash.status, 200);
    const html = await dash.text();
    assert.match(html, /Waypoint admin/);
    assert.match(html, /Integrations/);
    assert.match(html, /Users/);
    assert.match(html, /Pace samples/);
  });
});

test("admin API requires cookie", async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/admin/api/overview`);
    assert.equal(res.status, 401);
  });
});

test("admin data browse and user detail work after login", async () => {
  await withApp(async (base) => {
    const login = await fetch(`${base}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `password=${encodeURIComponent(ADMIN_PASSWORD)}`,
      redirect: "manual",
    });
    const setCookie = login.headers.getSetCookie?.() ?? [];
    const cookieHeader =
      setCookie.find((c) => c.startsWith("wp_admin=")) ??
      login.headers.get("set-cookie") ??
      "";
    const cookie = cookieHeader.split(";")[0];

    const usersPage = await fetch(`${base}/admin/data/users`, {
      headers: { Cookie: cookie },
    });
    assert.equal(usersPage.status, 200);
    assert.match(await usersPage.text(), /Users/);

    const api = await fetch(`${base}/admin/api/data/tasks`, {
      headers: { Cookie: cookie },
    });
    assert.equal(api.status, 200);
    const body = (await api.json()) as { table: string; rows: unknown[] };
    assert.equal(body.table, "tasks");
    assert.ok(Array.isArray(body.rows));

    const missing = await fetch(
      `${base}/admin/users/00000000-0000-4000-8000-000000000000`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(missing.status, 404);
  });
});
