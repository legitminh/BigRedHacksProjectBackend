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
import type { Store } from "../src/store/types.ts";

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
  fn: (base: string, store: Store) => Promise<void>,
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
    await fn(`http://127.0.0.1:${address.port}`, store);
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
    assert.match(html, /brand-mark/);
    assert.match(html, /\/admin\/favicon\.png/);
    assert.doesNotMatch(html, /Recent users/);
  });
});

test("admin favicon is public", async () => {
  await withApp(async (base) => {
    const png = await fetch(`${base}/admin/favicon.png`);
    assert.equal(png.status, 200);
    assert.match(png.headers.get("content-type") ?? "", /image\/png/);
    const bytes = Buffer.from(await png.arrayBuffer());
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");

    const ico = await fetch(`${base}/admin/favicon.ico`);
    assert.equal(ico.status, 200);
    assert.match(ico.headers.get("content-type") ?? "", /image\/x-icon|image\/vnd\.microsoft\.icon/);
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
    assert.match(html, /TigerData/);
    assert.match(html, /xAI TTS/);
    assert.match(html, /Presage camera/);
    assert.match(html, /Vision ·/);
    assert.match(html, /Drive cache/);
    assert.match(html, /School digests/);
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

    for (const table of ["drive_cache", "school_digests"] as const) {
      const page = await fetch(`${base}/admin/data/${table}`, {
        headers: { Cookie: cookie },
      });
      assert.equal(page.status, 200);
      const json = await fetch(`${base}/admin/api/data/${table}`, {
        headers: { Cookie: cookie },
      });
      assert.equal(json.status, 200);
      const payload = (await json.json()) as { table: string; rows: unknown[] };
      assert.equal(payload.table, table);
      assert.ok(Array.isArray(payload.rows));
    }

    const missing = await fetch(
      `${base}/admin/users/00000000-0000-4000-8000-000000000000`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(missing.status, 404);
  });
});

test("refresh token ids are not linked as user lookups", async () => {
  await withApp(async (base, store) => {
    const user = await store.upsertGoogleUser(
      {
        sub: "google-sub-token-link",
        email: "token-link@example.com",
        emailVerified: true,
        name: "Token Link",
        picture: null,
        googleRefreshToken: null,
      },
      new Date("2026-10-03T12:00:00.000Z"),
    );
    const tokenId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    await store.insertRefreshToken({
      id: tokenId,
      userId: user.id,
      tokenHash: "hash-for-admin-link-test",
      expiresAt: "2026-11-01T00:00:00.000Z",
      revokedAt: null,
      replacedBy: null,
      createdAt: "2026-10-03T12:00:00.000Z",
    });

    const cookie = adminSetCookie(await adminLogin(base)).split(";")[0];
    const page = await fetch(`${base}/admin/data/refresh_tokens`, {
      headers: { Cookie: cookie },
    });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.doesNotMatch(html, new RegExp(`/admin/users/${tokenId}`));
    assert.match(html, new RegExp(`/admin/users/${user.id}`));
  });
});

async function adminLogin(base: string): Promise<Response> {
  return fetch(`${base}/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `password=${encodeURIComponent(ADMIN_PASSWORD)}`,
    redirect: "manual",
  });
}

function adminSetCookie(res: Response): string {
  const list = res.headers.getSetCookie?.() ?? [];
  return list.find((c) => c.startsWith("wp_admin=")) ?? res.headers.get("set-cookie") ?? "";
}

test("admin cookie is not Secure on http PUBLIC_BASE_URL", async () => {
  await withApp(async (base) => {
    const cookie = adminSetCookie(await adminLogin(base));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.doesNotMatch(cookie, /;\s*Secure/i);
  });
});

test("admin login and logout cookies are Secure when PUBLIC_BASE_URL is https", async () => {
  const config = appConfig({ PUBLIC_BASE_URL: "https://api.example.com" });
  await withApp(
    async (base) => {
      const login = adminSetCookie(await adminLogin(base));
      assert.match(login, /;\s*Secure/);
      assert.match(login, /HttpOnly/);
      assert.match(login, /SameSite=Strict/);

      const logout = await fetch(`${base}/admin/logout`, { method: "POST", redirect: "manual" });
      assert.equal(logout.status, 303);
      const cleared = adminSetCookie(logout);
      assert.match(cleared, /wp_admin=;/);
      assert.match(cleared, /Max-Age=0/);
      assert.match(cleared, /;\s*Secure/);
    },
    { config },
  );
});

test("admin user delete requires a session and removes the user", async () => {
  await withApp(async (base, store) => {
    const user = await store.upsertGoogleUser(
      {
        sub: "google-sub-delete",
        email: "delete-me@example.com",
        emailVerified: true,
        name: "Delete Me",
        picture: null,
        googleRefreshToken: null,
      },
      new Date("2026-10-03T12:00:00.000Z"),
    );
    const url = `${base}/admin/users/${user.id}/delete`;

    const anon = await fetch(url, { method: "POST", redirect: "manual" });
    assert.equal(anon.status, 401);
    assert.ok(await store.getUser(user.id));

    const cookie = adminSetCookie(await adminLogin(base)).split(";")[0];
    const missing = await fetch(
      `${base}/admin/users/00000000-0000-4000-8000-000000000000/delete`,
      { method: "POST", headers: { Cookie: cookie }, redirect: "manual" },
    );
    assert.equal(missing.status, 404);

    const deleted = await fetch(url, {
      method: "POST",
      headers: { Cookie: cookie },
      redirect: "manual",
    });
    assert.equal(deleted.status, 303);
    assert.equal(deleted.headers.get("location"), "/admin");
    assert.equal(await store.getUser(user.id), null);
  });
});
