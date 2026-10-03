import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Config } from "./config.ts";
import { HttpError, escapeHtml, sendEmpty, sendHtml, sendJson } from "./http.ts";
import type { AdminOverview, Store } from "./store/types.ts";

const COOKIE = "wp_admin";
const MAX_BODY = 8 * 1024;

export type AdminDeps = {
  config: Config;
  store: Store;
};

function cookieSecret(config: Config): string {
  return config.sessionSecret ?? config.adminPassword ?? "waypoint-admin";
}

export function mintAdminCookie(config: Config): string {
  if (!config.adminPassword) {
    throw new HttpError(503, "admin_not_configured", "ADMIN_PASSWORD is not set.");
  }
  return createHmac("sha256", cookieSecret(config))
    .update(`admin-v1:${config.adminPassword}`)
    .digest("base64url");
}

export function adminAuthed(req: IncomingMessage, config: Config): boolean {
  if (!config.adminPassword) return false;
  const header = req.headers.cookie;
  if (!header) return false;
  const want = mintAdminCookie(config);
  for (const part of header.split(";")) {
    const [rawKey, ...rest] = part.trim().split("=");
    if (rawKey !== COOKIE) continue;
    const got = rest.join("=");
    try {
      const a = Buffer.from(got);
      const b = Buffer.from(want);
      return a.length === b.length && timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }
  return false;
}

export function passwordsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Still run a compare to reduce trivial timing leaks on length.
    timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32));
    return false;
  }
  return timingSafeEqual(a, b);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += buf.length;
    if (size > MAX_BODY) {
      throw new HttpError(413, "body_too_large", "Request body is too large.");
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readPassword(req: IncomingMessage): Promise<string> {
  const type = req.headers["content-type"] ?? "";
  const raw = await readBody(req);
  if (type.includes("application/json")) {
    try {
      const body = JSON.parse(raw || "{}") as { password?: unknown };
      return typeof body.password === "string" ? body.password : "";
    } catch {
      throw new HttpError(400, "invalid_json", "Request body is not valid JSON.");
    }
  }
  const params = new URLSearchParams(raw);
  return params.get("password") ?? "";
}

function setAdminCookie(res: ServerResponse, config: Config): void {
  const value = mintAdminCookie(config);
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${value}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=86400`,
  );
}

function clearAdminCookie(res: ServerResponse): void {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0`,
  );
}

function shell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --bg: #12141a;
      --panel: #1c2030;
      --ink: #e8e6f0;
      --muted: #9aa0b5;
      --line: rgba(255,255,255,0.08);
      --accent: #6ec8b0;
      --danger: #f0a0a0;
      --ok: #8fd49a;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
      background:
        radial-gradient(900px 420px at 10% -10%, rgba(110,200,176,0.14), transparent 55%),
        radial-gradient(700px 360px at 100% 0%, rgba(120,140,220,0.12), transparent 50%),
        var(--bg);
      color: var(--ink);
    }
    main { max-width: 920px; margin: 0 auto; padding: 2.5rem 1.25rem 3rem; }
    h1 { font-size: 1.55rem; margin: 0 0 0.35rem; letter-spacing: -0.02em; }
    .sub { color: var(--muted); margin: 0 0 1.5rem; }
    .panel {
      background: color-mix(in srgb, var(--panel) 92%, black);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 1.25rem 1.35rem;
      margin-bottom: 1rem;
    }
    label { display: block; font-size: 0.85rem; color: var(--muted); margin-bottom: 0.4rem; }
    input[type="password"] {
      width: 100%;
      padding: 0.7rem 0.8rem;
      border-radius: 10px;
      border: 1px solid var(--line);
      background: #0e1118;
      color: var(--ink);
      font-size: 1rem;
    }
    button, .btn {
      appearance: none;
      border: 0;
      border-radius: 999px;
      padding: 0.65rem 1.1rem;
      font-weight: 600;
      cursor: pointer;
      background: var(--accent);
      color: #102018;
    }
    button.ghost {
      background: transparent;
      color: var(--muted);
      border: 1px solid var(--line);
    }
    .row { display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; margin-top: 1rem; }
    .err { color: var(--danger); margin: 0.75rem 0 0; font-size: 0.92rem; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 0.75rem;
    }
    .stat {
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 0.85rem 0.95rem;
      background: rgba(0,0,0,0.18);
    }
    .stat strong { display: block; font-size: 1.35rem; margin-top: 0.2rem; }
    .stat span { color: var(--muted); font-size: 0.8rem; }
    table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    th, td { text-align: left; padding: 0.55rem 0.35rem; border-bottom: 1px solid var(--line); }
    th { color: var(--muted); font-weight: 600; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em; }
    .pill {
      display: inline-block;
      padding: 0.15rem 0.55rem;
      border-radius: 999px;
      font-size: 0.78rem;
      border: 1px solid var(--line);
    }
    .pill.ok { color: var(--ok); border-color: rgba(143,212,154,0.35); }
    .pill.bad { color: var(--danger); border-color: rgba(240,160,160,0.35); }
    .pill.soft { color: var(--muted); }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85em; }
  </style>
</head>
<body>
  <main>
    ${body}
  </main>
</body>
</html>`;
}

function loginPage(error?: string): string {
  return shell(
    "Waypoint Admin",
    `
    <h1>Waypoint admin</h1>
    <p class="sub">Local operator console. Password is set via <code>ADMIN_PASSWORD</code>.</p>
    <div class="panel">
      <form method="POST" action="/admin/login" autocomplete="current-password">
        <label for="password">Admin password</label>
        <input id="password" name="password" type="password" required autofocus />
        <div class="row">
          <button type="submit">Sign in</button>
        </div>
        ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
      </form>
    </div>
    `,
  );
}

function flag(ok: boolean, yes = "ready", no = "missing"): string {
  return ok
    ? `<span class="pill ok">${escapeHtml(yes)}</span>`
    : `<span class="pill bad">${escapeHtml(no)}</span>`;
}

function dashboardPage(config: Config, overview: AdminOverview): string {
  const rows = overview.users
    .map(
      (u) => `
      <tr>
        <td>${escapeHtml(u.email ?? "—")}</td>
        <td>${escapeHtml(u.name ?? "—")}</td>
        <td><code>${escapeHtml(u.id.slice(0, 8))}…</code></td>
        <td>${escapeHtml(u.last_login_at ?? "—")}</td>
      </tr>`,
    )
    .join("");

  return shell(
    "Waypoint Admin",
    `
    <div class="row" style="justify-content: space-between; margin-bottom: 0.5rem">
      <div>
        <h1>Waypoint admin</h1>
        <p class="sub" style="margin:0">Service overview · storage <strong>${escapeHtml(overview.storage)}</strong></p>
      </div>
      <form method="POST" action="/admin/logout"><button class="ghost" type="submit">Sign out</button></form>
    </div>

    <div class="panel">
      <div class="grid">
        <div class="stat"><span>Users</span><strong>${overview.userCount}</strong></div>
        <div class="stat"><span>Sessions</span><strong>${overview.sessionCount}</strong></div>
        <div class="stat"><span>Tasks</span><strong>${overview.taskCount}</strong></div>
        <div class="stat"><span>Active refresh tokens</span><strong>${overview.activeRefreshTokens}</strong></div>
      </div>
    </div>

    <div class="panel">
      <h2 style="margin:0 0 0.85rem; font-size:1.05rem">Integrations</h2>
      <table>
        <tbody>
          <tr><th>Google OAuth</th><td>${flag(Boolean(config.googleClientId && config.googleClientSecret))}</td></tr>
          <tr><th>Gemini</th><td>${flag(Boolean(config.geminiApiKey), config.geminiModel, "not set")}</td></tr>
          <tr><th>Coach / Ollama</th><td>${flag(Boolean(config.ollamaBaseUrl), config.ollamaModel, "disabled")}</td></tr>
          <tr><th>Coach API token</th><td>${flag(Boolean(config.coachApiToken))}</td></tr>
          <tr><th>Session secret</th><td>${flag(Boolean(config.sessionSecret))}</td></tr>
          <tr><th>Public base</th><td><span class="pill soft">${escapeHtml(config.publicBaseUrl)}</span></td></tr>
        </tbody>
      </table>
    </div>

    <div class="panel">
      <h2 style="margin:0 0 0.85rem; font-size:1.05rem">Recent users</h2>
      ${
        overview.users.length === 0
          ? `<p class="sub" style="margin:0">No users yet.</p>`
          : `<table>
              <thead><tr><th>Email</th><th>Name</th><th>Id</th><th>Last login</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>`
      }
    </div>
    `,
  );
}

/** Returns true if the request was handled as an admin route. */
export async function handleAdmin(
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminDeps,
): Promise<boolean> {
  if (!path.startsWith("/admin")) return false;

  if (!deps.config.adminPassword) {
    if (method === "GET" && path === "/admin") {
      sendHtml(
        res,
        503,
        shell(
          "Admin unavailable",
          `<h1>Admin unavailable</h1><p class="sub">Set <code>ADMIN_PASSWORD</code> in <code>.env</code> and restart the API.</p>`,
        ),
      );
      return true;
    }
    throw new HttpError(503, "admin_not_configured", "ADMIN_PASSWORD is not set.");
  }

  if (method === "GET" && path === "/admin") {
    if (!adminAuthed(req, deps.config)) {
      sendHtml(res, 200, loginPage());
      return true;
    }
    const overview = await deps.store.adminOverview();
    sendHtml(res, 200, dashboardPage(deps.config, overview));
    return true;
  }

  if (method === "POST" && path === "/admin/login") {
    const password = await readPassword(req);
    if (!passwordsMatch(password, deps.config.adminPassword)) {
      sendHtml(res, 401, loginPage("Incorrect password."));
      return true;
    }
    setAdminCookie(res, deps.config);
    res.writeHead(303, { Location: "/admin", "Cache-Control": "no-store" });
    res.end();
    return true;
  }

  if (method === "POST" && path === "/admin/logout") {
    clearAdminCookie(res);
    res.writeHead(303, { Location: "/admin", "Cache-Control": "no-store" });
    res.end();
    return true;
  }

  if (method === "GET" && path === "/admin/api/overview") {
    if (!adminAuthed(req, deps.config)) {
      throw new HttpError(401, "unauthorized", "Admin sign-in required.");
    }
    sendJson(res, 200, await deps.store.adminOverview());
    return true;
  }

  if (path === "/admin" || path.startsWith("/admin/")) {
    if (method === "GET" || method === "POST") {
      throw new HttpError(404, "not_found", "No admin route for that path.");
    }
    sendEmpty(res, 405);
    return true;
  }

  return false;
}
