import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Config } from "./config.ts";
import { HttpError, escapeHtml, sendEmpty, sendHtml, sendJson } from "./http.ts";
import type {
  AdminBrowseResult,
  AdminBrowseTable,
  AdminOverview,
  AdminUserDetail,
  Store,
} from "./store/types.ts";

const COOKIE = "wp_admin";
const MAX_BODY = 8 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const BROWSE_TABLES: { id: AdminBrowseTable; label: string }[] = [
  { id: "users", label: "Users" },
  { id: "profiles", label: "Profiles" },
  { id: "tasks", label: "Tasks" },
  { id: "sessions", label: "Sessions" },
  { id: "pace", label: "Pace samples" },
  { id: "proficiencies", label: "Proficiencies" },
  { id: "refresh_tokens", label: "Refresh tokens" },
  { id: "email_codes", label: "Email codes" },
];

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

function requireAdmin(req: IncomingMessage, config: Config): void {
  if (!adminAuthed(req, config)) {
    throw new HttpError(401, "unauthorized", "Admin sign-in required.");
  }
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
    main { max-width: 1100px; margin: 0 auto; padding: 2rem 1.25rem 3rem; }
    h1 { font-size: 1.55rem; margin: 0 0 0.35rem; letter-spacing: -0.02em; }
    h2 { margin: 0 0 0.85rem; font-size: 1.05rem; }
    h3 { margin: 1.25rem 0 0.55rem; font-size: 0.95rem; color: var(--muted); font-weight: 600; }
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
      padding: 0.55rem 1rem;
      font-weight: 600;
      cursor: pointer;
      background: var(--accent);
      color: #102018;
      text-decoration: none;
      display: inline-block;
      font-size: 0.9rem;
    }
    button.ghost, a.btn.ghost {
      background: transparent;
      color: var(--muted);
      border: 1px solid var(--line);
    }
    a.btn.soft {
      background: rgba(110,200,176,0.12);
      color: var(--accent);
      border: 1px solid rgba(110,200,176,0.28);
    }
    .row { display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; margin-top: 1rem; }
    .err { color: var(--danger); margin: 0.75rem 0 0; font-size: 0.92rem; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      gap: 0.75rem;
    }
    .stat {
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 0.85rem 0.95rem;
      background: rgba(0,0,0,0.18);
    }
    .stat strong { display: block; font-size: 1.35rem; margin-top: 0.2rem; }
    .stat span { color: var(--muted); font-size: 0.78rem; }
    .nav {
      display: flex; flex-wrap: wrap; gap: 0.45rem;
      margin: 0 0 1.1rem;
    }
    .nav a {
      color: var(--muted);
      text-decoration: none;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 0.35rem 0.8rem;
      font-size: 0.82rem;
      font-weight: 600;
    }
    .nav a.active, .nav a:hover {
      color: var(--ink);
      border-color: rgba(110,200,176,0.45);
      background: rgba(110,200,176,0.08);
    }
    .scroll { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 0.86rem; }
    th, td { text-align: left; padding: 0.5rem 0.4rem; border-bottom: 1px solid var(--line); vertical-align: top; }
    th { color: var(--muted); font-weight: 600; font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.04em; }
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
    code, pre {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.82em;
    }
    pre {
      margin: 0;
      padding: 0.85rem 1rem;
      border-radius: 12px;
      background: #0e1118;
      border: 1px solid var(--line);
      overflow: auto;
      max-height: 28rem;
      white-space: pre-wrap;
      word-break: break-word;
    }
    a.link { color: var(--accent); text-decoration: none; font-weight: 600; }
    a.link:hover { text-decoration: underline; }
    .kv { display: grid; grid-template-columns: 11rem 1fr; gap: 0.35rem 0.75rem; font-size: 0.9rem; }
    .kv dt { color: var(--muted); margin: 0; }
    .kv dd { margin: 0; }
    .muted { color: var(--muted); }
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

function nav(active: string): string {
  const links = [
    { href: "/admin", id: "overview", label: "Overview" },
    ...BROWSE_TABLES.map((t) => ({
      href: `/admin/data/${t.id}`,
      id: t.id,
      label: t.label,
    })),
  ];
  return `<nav class="nav" aria-label="Admin sections">${links
    .map(
      (l) =>
        `<a href="${l.href}" class="${l.id === active ? "active" : ""}">${escapeHtml(l.label)}</a>`,
    )
    .join("")}</nav>`;
}

function headerBar(title: string, sub: string): string {
  return `
    <div class="row" style="justify-content: space-between; margin-bottom: 0.35rem">
      <div>
        <h1>${escapeHtml(title)}</h1>
        <p class="sub" style="margin:0">${sub}</p>
      </div>
      <form method="POST" action="/admin/logout"><button class="ghost" type="submit">Sign out</button></form>
    </div>`;
}

function jsonBlock(value: unknown): string {
  return `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") {
    return `<code title="${escapeHtml(JSON.stringify(value))}">${escapeHtml(
      JSON.stringify(value).slice(0, 80),
    )}${JSON.stringify(value).length > 80 ? "…" : ""}</code>`;
  }
  const text = String(value);
  if (/^[0-9a-f-]{36}$/i.test(text)) {
    return `<a class="link" href="/admin/users/${escapeHtml(text)}"><code>${escapeHtml(text.slice(0, 8))}…</code></a>`;
  }
  return escapeHtml(text);
}

function rowsTable(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return `<p class="sub" style="margin:0">No rows.</p>`;
  const keys = Object.keys(rows[0] ?? {});
  return `<div class="scroll"><table>
    <thead><tr>${keys.map((k) => `<th>${escapeHtml(k)}</th>`).join("")}</tr></thead>
    <tbody>
      ${rows
        .map(
          (row) =>
            `<tr>${keys.map((k) => `<td>${cell(row[k])}</td>`).join("")}</tr>`,
        )
        .join("")}
    </tbody>
  </table></div>`;
}

function dashboardPage(config: Config, overview: AdminOverview): string {
  const rows = overview.users
    .map(
      (u) => `
      <tr>
        <td><a class="link" href="/admin/users/${escapeHtml(u.id)}">${escapeHtml(u.email ?? "—")}</a></td>
        <td>${escapeHtml(u.name ?? "—")}</td>
        <td><code>${escapeHtml(u.id.slice(0, 8))}…</code></td>
        <td>${u.calendar_connected ? '<span class="pill ok">linked</span>' : '<span class="pill soft">no</span>'}</td>
        <td>${escapeHtml(u.last_login_at ?? "—")}</td>
        <td><a class="btn soft" href="/admin/users/${escapeHtml(u.id)}">Open</a></td>
      </tr>`,
    )
    .join("");

  return shell(
    "Waypoint Admin",
    `
    ${headerBar("Waypoint admin", `Storage <strong>${escapeHtml(overview.storage)}</strong> · click any user for a full dump`)}
    ${nav("overview")}

    <div class="panel">
      <div class="grid">
        <div class="stat"><span>Users</span><strong>${overview.userCount}</strong></div>
        <div class="stat"><span>Profiles</span><strong>${overview.profileCount}</strong></div>
        <div class="stat"><span>Sessions</span><strong>${overview.sessionCount}</strong></div>
        <div class="stat"><span>Tasks</span><strong>${overview.taskCount}</strong></div>
        <div class="stat"><span>Pace samples</span><strong>${overview.paceCount}</strong></div>
        <div class="stat"><span>Proficiencies</span><strong>${overview.proficiencyCount}</strong></div>
        <div class="stat"><span>Email codes</span><strong>${overview.emailCodeCount}</strong></div>
        <div class="stat"><span>Active refresh tokens</span><strong>${overview.activeRefreshTokens}</strong></div>
      </div>
    </div>

    <div class="panel">
      <h2>Integrations</h2>
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
      <h2>Users</h2>
      ${
        overview.users.length === 0
          ? `<p class="sub" style="margin:0">No users yet.</p>`
          : `<div class="scroll"><table>
              <thead><tr><th>Email</th><th>Name</th><th>Id</th><th>Google data</th><th>Last login</th><th></th></tr></thead>
              <tbody>${rows}</tbody>
            </table></div>`
      }
    </div>
    `,
  );
}

function userDetailPage(detail: AdminUserDetail): string {
  const u = detail.user;
  return shell(
    `User ${u.email ?? u.id}`,
    `
    ${headerBar(u.email ?? u.name ?? "User", `User detail · <a class="link" href="/admin">← Overview</a>`)}
    ${nav("users")}

    <div class="panel">
      <h2>Identity</h2>
      <dl class="kv">
        <dt>Id</dt><dd><code>${escapeHtml(u.id)}</code></dd>
        <dt>Email</dt><dd>${escapeHtml(u.email ?? "—")} ${u.email_verified ? '<span class="pill ok">verified</span>' : '<span class="pill soft">unverified</span>'}</dd>
        <dt>Name</dt><dd>${escapeHtml(u.name ?? "—")}</dd>
        <dt>Google sub</dt><dd><code>${escapeHtml(u.google_sub ?? "—")}</code></dd>
        <dt>Picture</dt><dd>${u.picture ? `<a class="link" href="${escapeHtml(u.picture)}" target="_blank" rel="noreferrer">open</a>` : "—"}</dd>
        <dt>Calendar / Drive</dt><dd>${u.calendar_connected ? '<span class="pill ok">connected</span>' : '<span class="pill bad">not connected</span>'}</dd>
        <dt>Google refresh token</dt><dd>${u.has_google_refresh_token ? '<span class="pill ok">present</span>' : '<span class="pill bad">missing</span>'}</dd>
        <dt>Created</dt><dd>${escapeHtml(u.created_at ?? "—")}</dd>
        <dt>Last login</dt><dd>${escapeHtml(u.last_login_at ?? "—")}</dd>
        <dt>Refresh tokens</dt><dd>${detail.tokens.active} active · ${detail.tokens.revoked} revoked · ${detail.tokens.total} total</dd>
      </dl>
    </div>

    <div class="panel">
      <h2>Profile / study memory</h2>
      ${detail.profile ? jsonBlock(detail.profile) : `<p class="muted" style="margin:0">No profile row.</p>`}
    </div>

    <div class="panel">
      <h2>Proficiencies (${detail.proficiencies.length})</h2>
      ${rowsTable(detail.proficiencies as unknown as Record<string, unknown>[])}
    </div>

    <div class="panel">
      <h2>Tasks (${detail.tasks.length})</h2>
      ${rowsTable(detail.tasks as unknown as Record<string, unknown>[])}
    </div>

    <div class="panel">
      <h2>Session recaps (${detail.sessions.length})</h2>
      ${rowsTable(detail.sessions as unknown as Record<string, unknown>[])}
    </div>

    <div class="panel">
      <h2>Pace samples (${detail.pace.length})</h2>
      ${rowsTable(detail.pace as unknown as Record<string, unknown>[])}
    </div>

    <div class="panel">
      <h2>Raw JSON</h2>
      <p class="sub">Full detail payload (secrets like Google refresh tokens are never included).</p>
      ${jsonBlock(detail)}
      <div class="row">
        <a class="btn ghost" href="/admin/api/users/${escapeHtml(u.id)}">JSON API</a>
      </div>
    </div>
    `,
  );
}

function browsePage(result: AdminBrowseResult): string {
  const label = BROWSE_TABLES.find((t) => t.id === result.table)?.label ?? result.table;
  return shell(
    `Data · ${label}`,
    `
    ${headerBar(label, `${result.count} total${result.truncated ? " · showing first page" : ""} · <a class="link" href="/admin">← Overview</a>`)}
    ${nav(result.table)}
    <div class="panel">
      <div class="row" style="margin-top:0; margin-bottom:0.85rem; justify-content:space-between">
        <h2 style="margin:0">${escapeHtml(label)}</h2>
        <a class="btn ghost" href="/admin/api/data/${escapeHtml(result.table)}">JSON API</a>
      </div>
      ${rowsTable(result.rows)}
    </div>
    `,
  );
}

function parseBrowseTable(value: string): AdminBrowseTable | null {
  return BROWSE_TABLES.some((t) => t.id === value) ? (value as AdminBrowseTable) : null;
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

  const userMatch = path.match(/^\/admin\/users\/([^/]+)$/);
  if (method === "GET" && userMatch) {
    requireAdmin(req, deps.config);
    const id = decodeURIComponent(userMatch[1] ?? "");
    if (!UUID_RE.test(id)) {
      throw new HttpError(400, "invalid_user_id", "User id must be a UUID.");
    }
    const detail = await deps.store.adminUserDetail(id);
    if (!detail) throw new HttpError(404, "user_not_found", "No user with that id.");
    sendHtml(res, 200, userDetailPage(detail));
    return true;
  }

  const dataMatch = path.match(/^\/admin\/data\/([^/]+)$/);
  if (method === "GET" && dataMatch) {
    requireAdmin(req, deps.config);
    const table = parseBrowseTable(decodeURIComponent(dataMatch[1] ?? ""));
    if (!table) throw new HttpError(404, "not_found", "Unknown data table.");
    const browse = await deps.store.adminBrowse(table, 200);
    sendHtml(res, 200, browsePage(browse));
    return true;
  }

  if (method === "GET" && path === "/admin/api/overview") {
    requireAdmin(req, deps.config);
    sendJson(res, 200, await deps.store.adminOverview());
    return true;
  }

  const apiUserMatch = path.match(/^\/admin\/api\/users\/([^/]+)$/);
  if (method === "GET" && apiUserMatch) {
    requireAdmin(req, deps.config);
    const id = decodeURIComponent(apiUserMatch[1] ?? "");
    if (!UUID_RE.test(id)) {
      throw new HttpError(400, "invalid_user_id", "User id must be a UUID.");
    }
    const detail = await deps.store.adminUserDetail(id);
    if (!detail) throw new HttpError(404, "user_not_found", "No user with that id.");
    sendJson(res, 200, detail);
    return true;
  }

  const apiDataMatch = path.match(/^\/admin\/api\/data\/([^/]+)$/);
  if (method === "GET" && apiDataMatch) {
    requireAdmin(req, deps.config);
    const table = parseBrowseTable(decodeURIComponent(apiDataMatch[1] ?? ""));
    if (!table) throw new HttpError(404, "not_found", "Unknown data table.");
    sendJson(res, 200, await deps.store.adminBrowse(table, 500));
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
