import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { googleConfigured, smtpConfigured, type Config } from "./config.ts";
import { HttpError, escapeHtml, sendEmpty, sendHtml, sendJson } from "./http.ts";
import {
  clientIp,
  rateLimited,
  type RateLimiter,
  type RateRule,
} from "./security/rateLimit.ts";
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
const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
const SHIP_ICON_PNG = readFileSync(join(ASSETS_DIR, "ship-icon.png"));
const FAVICON_ICO = readFileSync(join(ASSETS_DIR, "favicon.ico"));

const BROWSE_TABLES: { id: AdminBrowseTable; label: string; group: "product" | "google" | "auth" }[] =
  [
    { id: "users", label: "Users", group: "product" },
    { id: "profiles", label: "Profiles", group: "product" },
    { id: "tasks", label: "Tasks", group: "product" },
    { id: "sessions", label: "Sessions", group: "product" },
    { id: "session_notes", label: "Session notes", group: "product" },
    { id: "pace", label: "Pace", group: "product" },
    { id: "proficiencies", label: "Proficiencies", group: "product" },
    { id: "drive_cache", label: "Drive cache", group: "google" },
    { id: "school_digests", label: "School digests", group: "google" },
    { id: "refresh_tokens", label: "Refresh tokens", group: "auth" },
    { id: "email_codes", label: "Email codes", group: "auth" },
  ];

const PILL_KEYS = new Set([
  "status",
  "mode",
  "outcome",
  "attention",
  "level",
  "email_verified",
  "calendar_connected",
  "has_google_refresh_token",
  "has_study_memory",
  "has_code_hash",
  "active",
  "kind",
]);

export type AdminDeps = {
  config: Config;
  store: Store;
  /** Optional abuse shield for POST /admin/login (per-IP). */
  limiter?: RateLimiter;
  adminLoginRule?: RateRule;
  now?: () => Date;
};

function cookieSecret(config: Config): string {
  return config.sessionSecret ?? config.adminPassword ?? "waypoint-admin";
}

export function mintAdminCookie(config: Config): string {
  if (!config.adminPassword) {
    throw new HttpError(503, "admin_not_configured", "Admin is unavailable.");
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

/** Add `; Secure` when the public origin is https (TLS terminated at the proxy). */
function secureCookieSuffix(config: Config): string {
  return config.publicBaseUrl.toLowerCase().startsWith("https://") ? "; Secure" : "";
}

function setAdminCookie(res: ServerResponse, config: Config): void {
  const value = mintAdminCookie(config);
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${value}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=86400${secureCookieSuffix(config)}`,
  );
}

function clearAdminCookie(res: ServerResponse, config: Config): void {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0${secureCookieSuffix(config)}`,
  );
}

function requireAdmin(req: IncomingMessage, config: Config): void {
  if (!adminAuthed(req, config)) {
    throw new HttpError(401, "unauthorized", "Admin sign-in required.");
  }
}

function brandHeading(title: string): string {
  return `<div class="brand">
      <img class="brand-mark" src="/admin/favicon.png" width="36" height="36" alt="" aria-hidden="true" />
      <h1><span class="brand-star" aria-hidden="true">✦</span> ${escapeHtml(title)}</h1>
    </div>`;
}

function shell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="icon" type="image/png" href="/admin/favicon.png" />
  <link rel="shortcut icon" href="/admin/favicon.ico" />
  <link rel="apple-touch-icon" href="/admin/favicon.png" />
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
      --warn: #e6c07b;
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
    main { max-width: 1180px; margin: 0 auto; padding: 2rem 1.25rem 3rem; }
    h1 { font-size: 1.55rem; margin: 0 0 0.35rem; letter-spacing: -0.02em; }
    .brand {
      display: flex;
      align-items: center;
      gap: 0.65rem;
      margin: 0 0 0.35rem;
    }
    .brand h1 { margin: 0; display: flex; align-items: center; gap: 0.4rem; }
    .brand-mark {
      width: 2.15rem;
      height: 2.15rem;
      border-radius: 50%;
      display: block;
      flex-shrink: 0;
      object-fit: cover;
      box-shadow: 0 0 0 1px rgba(255,255,255,0.08);
    }
    .brand-star { color: var(--accent); font-size: 0.95rem; }
    h2 { margin: 0 0 0.85rem; font-size: 1.05rem; }
    h3 { margin: 0 0 0.65rem; font-size: 0.88rem; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
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
      grid-template-columns: repeat(auto-fit, minmax(118px, 1fr));
      gap: 0.65rem;
    }
    .stat {
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 0.75rem 0.85rem;
      background: rgba(0,0,0,0.18);
    }
    .stat strong { display: block; font-size: 1.3rem; margin-top: 0.15rem; }
    .stat span { color: var(--muted); font-size: 0.74rem; }
    .nav-wrap { margin: 0 0 1.1rem; display: grid; gap: 0.45rem; }
    .nav {
      display: flex; flex-wrap: wrap; gap: 0.4rem;
      align-items: center;
    }
    .nav .group { color: var(--muted); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; margin-right: 0.15rem; }
    .nav a {
      color: var(--muted);
      text-decoration: none;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 0.3rem 0.72rem;
      font-size: 0.8rem;
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
    th { color: var(--muted); font-weight: 600; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; white-space: nowrap; }
    .pill {
      display: inline-block;
      padding: 0.12rem 0.5rem;
      border-radius: 999px;
      font-size: 0.76rem;
      border: 1px solid var(--line);
      white-space: nowrap;
    }
    .pill.ok { color: var(--ok); border-color: rgba(143,212,154,0.35); }
    .pill.bad { color: var(--danger); border-color: rgba(240,160,160,0.35); }
    .pill.warn { color: var(--warn); border-color: rgba(230,192,123,0.35); }
    .pill.soft { color: var(--muted); }
    .chips { display: flex; flex-wrap: wrap; gap: 0.35rem; }
    .chip {
      display: inline-block;
      padding: 0.2rem 0.55rem;
      border-radius: 8px;
      background: rgba(255,255,255,0.05);
      border: 1px solid var(--line);
      font-size: 0.8rem;
    }
    .flags { display: flex; flex-wrap: wrap; gap: 0.45rem; }
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
      max-height: 22rem;
      white-space: pre-wrap;
      word-break: break-word;
    }
    a.link { color: var(--accent); text-decoration: none; font-weight: 600; }
    a.link:hover { text-decoration: underline; }
    .kv { display: grid; grid-template-columns: 10.5rem 1fr; gap: 0.35rem 0.75rem; font-size: 0.9rem; }
    .kv dt { color: var(--muted); margin: 0; }
    .kv dd { margin: 0; }
    .muted { color: var(--muted); }
    .preview { color: var(--muted); font-size: 0.8rem; max-width: 22rem; }
    .digest + .digest { margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--line); }
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
    ${brandHeading("Waypoint admin")}
    <p class="sub">Local operator console.</p>
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
  const groups: { id: "product" | "google" | "auth"; label: string }[] = [
    { id: "product", label: "Product" },
    { id: "google", label: "Google" },
    { id: "auth", label: "Auth" },
  ];
  const overview = `<a href="/admin" class="${active === "overview" ? "active" : ""}">Overview</a>`;
  const sections = groups
    .map((group) => {
      const items = BROWSE_TABLES.filter((t) => t.group === group.id)
        .map(
          (t) =>
            `<a href="/admin/data/${t.id}" class="${t.id === active ? "active" : ""}">${escapeHtml(t.label)}</a>`,
        )
        .join("");
      return `<div class="nav"><span class="group">${escapeHtml(group.label)}</span>${items}</div>`;
    })
    .join("");
  return `<div class="nav-wrap" aria-label="Admin sections">
    <div class="nav">${overview}</div>
    ${sections}
  </div>`;
}

function headerBar(title: string, sub: string): string {
  return `
    <div class="row" style="justify-content: space-between; margin-bottom: 0.35rem">
      <div>
        ${brandHeading(title)}
        <p class="sub" style="margin:0">${sub}</p>
      </div>
      <form method="POST" action="/admin/logout"><button class="ghost" type="submit">Sign out</button></form>
    </div>`;
}

function sendAdminAsset(
  res: ServerResponse,
  body: Buffer,
  contentType: string,
): void {
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": body.length,
    "Cache-Control": "public, max-age=86400",
  });
  res.end(body);
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function boolPill(value: boolean, yes = "yes", no = "no"): string {
  return value
    ? `<span class="pill ok">${escapeHtml(yes)}</span>`
    : `<span class="pill soft">${escapeHtml(no)}</span>`;
}

function statusPill(value: string): string {
  const lower = value.toLowerCase();
  const tone =
    lower === "active" || lower === "done" || lower === "completed" || lower === "true"
      ? "ok"
      : lower === "dropped" || lower === "failed" || lower === "false" || lower === "revoked"
        ? "bad"
        : lower === "distracted" || lower === "partial"
          ? "warn"
          : "soft";
  return `<span class="pill ${tone}">${escapeHtml(value)}</span>`;
}

function chips(values: string[]): string {
  if (values.length === 0) return `<span class="muted">—</span>`;
  return `<div class="chips">${values
    .map((v) => `<span class="chip">${escapeHtml(v)}</span>`)
    .join("")}</div>`;
}

function userLink(id: string): string {
  return `<a class="link" href="/admin/users/${escapeHtml(id)}"><code>${escapeHtml(shortId(id))}</code></a>`;
}

function cell(key: string, value: unknown, options: { linkUserIds?: boolean } = {}): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") {
    if (PILL_KEYS.has(key)) return boolPill(value);
    return value ? "true" : "false";
  }
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string")) {
      return chips(value as string[]);
    }
    if (
      value.every(
        (item) =>
          item &&
          typeof item === "object" &&
          "name" in item &&
          typeof (item as { name: unknown }).name === "string",
      )
    ) {
      return chips((value as { name: string }[]).map((item) => item.name));
    }
    const text = JSON.stringify(value);
    return `<code title="${escapeHtml(text)}">${escapeHtml(text.slice(0, 80))}${text.length > 80 ? "…" : ""}</code>`;
  }
  if (typeof value === "object") {
    const text = JSON.stringify(value);
    return `<code title="${escapeHtml(text)}">${escapeHtml(text.slice(0, 80))}${text.length > 80 ? "…" : ""}</code>`;
  }
  const text = String(value);
  if (key === "user_id" && isUuid(text)) return userLink(text);
  if (options.linkUserIds && key === "id" && isUuid(text)) return userLink(text);
  if (PILL_KEYS.has(key) && text.length < 40) return statusPill(text);
  if (key === "text_preview" || key.endsWith("_preview")) {
    return `<span class="preview" title="${escapeHtml(text)}">${escapeHtml(text || "—")}</span>`;
  }
  if (isUuid(text) || text.length > 36) {
    return `<code title="${escapeHtml(text)}">${escapeHtml(shortId(text))}</code>`;
  }
  return escapeHtml(text);
}

function rowsTable(
  rows: Record<string, unknown>[],
  options: { linkUserIds?: boolean } = {},
): string {
  if (rows.length === 0) return `<p class="sub" style="margin:0">No rows.</p>`;
  const keys = Object.keys(rows[0] ?? {});
  return `<div class="scroll"><table>
    <thead><tr>${keys.map((k) => `<th>${escapeHtml(k)}</th>`).join("")}</tr></thead>
    <tbody>
      ${rows
        .map(
          (row) =>
            `<tr>${keys.map((k) => `<td>${cell(k, row[k], options)}</td>`).join("")}</tr>`,
        )
        .join("")}
    </tbody>
  </table></div>`;
}

function profilePanel(profile: NonNullable<AdminUserDetail["profile"]>): string {
  const memory = profile.study_memory;
  return `
    <dl class="kv">
      <dt>Updated</dt><dd>${escapeHtml(profile.updated_at)}</dd>
      <dt>Interests</dt><dd>${chips(profile.interests)}</dd>
      <dt>Long-term goals</dt><dd>${chips(profile.long_term_goals)}</dd>
      <dt>Priorities</dt><dd>${chips(profile.priorities)}</dd>
      <dt>Interaction</dt><dd><code>${escapeHtml(JSON.stringify(profile.interaction))}</code></dd>
    </dl>
    ${
      memory
        ? `<h3 style="margin-top:1.1rem">Study memory</h3>
           <dl class="kv">
             <dt>Updated</dt><dd>${escapeHtml(memory.updated_at)}</dd>
             <dt>Stats</dt><dd><code>${escapeHtml(JSON.stringify(memory.stats ?? {}))}</code></dd>
           </dl>
           <pre style="margin-top:0.75rem">${escapeHtml(memory.narrative || "(empty narrative)")}</pre>`
        : `<p class="muted" style="margin:0.85rem 0 0">No study memory blob.</p>`
    }`;
}

function digestsPanel(digests: AdminUserDetail["schoolDigests"]): string {
  if (digests.length === 0) return `<p class="muted" style="margin:0">No school digests.</p>`;
  return digests
    .map(
      (d) => `
      <div class="digest">
        <dl class="kv">
          <dt>Date</dt><dd><strong>${escapeHtml(d.digest_date)}</strong></dd>
          <dt>Timezone</dt><dd>${escapeHtml(d.timezone)}</dd>
          <dt>Model</dt><dd><span class="pill soft">${escapeHtml(d.model)}</span></dd>
          <dt>Sources</dt><dd>${chips(d.sources.map((s) => s.name))}</dd>
          <dt>Chars</dt><dd>${d.text_chars}</dd>
          <dt>Created</dt><dd>${escapeHtml(d.created_at)}</dd>
          <dt>Updated</dt><dd>${escapeHtml(d.updated_at)}</dd>
        </dl>
        <pre style="margin-top:0.75rem">${escapeHtml(d.digest_text)}</pre>
      </div>`,
    )
    .join("");
}

function dashboardPage(config: Config, overview: AdminOverview): string {
  const rows = overview.users
    .map(
      (u) => `
      <tr>
        <td><a class="link" href="/admin/users/${escapeHtml(u.id)}">${escapeHtml(u.email ?? "—")}</a></td>
        <td>${escapeHtml(u.name ?? "—")}</td>
        <td><code title="${escapeHtml(u.id)}">${escapeHtml(shortId(u.id))}</code></td>
        <td>${u.calendar_connected ? '<span class="pill ok">linked</span>' : '<span class="pill soft">no</span>'}</td>
        <td>${escapeHtml(u.last_login_at ?? "—")}</td>
        <td><a class="btn soft" href="/admin/users/${escapeHtml(u.id)}">Open</a></td>
      </tr>`,
    )
    .join("");

  return shell(
    "Waypoint Admin",
    `
    ${headerBar("Waypoint admin", `Storage <strong>${escapeHtml(overview.storage)}</strong> · TigerData field browser`)}
    ${nav("overview")}

    <div class="panel">
      <h3>Product</h3>
      <div class="grid">
        <div class="stat"><span>Users</span><strong>${overview.userCount}</strong></div>
        <div class="stat"><span>Profiles</span><strong>${overview.profileCount}</strong></div>
        <div class="stat"><span>Tasks</span><strong>${overview.taskCount}</strong></div>
        <div class="stat"><span>Sessions</span><strong>${overview.sessionCount}</strong></div>
        <div class="stat"><span>Pace samples</span><strong>${overview.paceCount}</strong></div>
        <div class="stat"><span>Proficiencies</span><strong>${overview.proficiencyCount}</strong></div>
      </div>
      <h3 style="margin-top:1.1rem">Google</h3>
      <div class="grid">
        <div class="stat"><span>Drive cache</span><strong>${overview.driveCacheCount}</strong></div>
        <div class="stat"><span>School digests</span><strong>${overview.schoolDigestCount}</strong></div>
      </div>
      <h3 style="margin-top:1.1rem">Auth</h3>
      <div class="grid">
        <div class="stat"><span>Email codes</span><strong>${overview.emailCodeCount}</strong></div>
        <div class="stat"><span>Active refresh tokens</span><strong>${overview.activeRefreshTokens}</strong></div>
      </div>
    </div>

    <div class="panel">
      <h2>Integrations</h2>
      <div class="flags" style="margin-bottom:0.75rem">
        ${flag(Boolean(config.databaseUrl), "TigerData", "TigerData (file store)")}
        ${flag(googleConfigured(config), "Google OAuth", "Google OAuth")}
        ${flag(Boolean(config.sessionSecret), "Sessions", "Sessions")}
        ${flag(smtpConfigured(config), "SMTP email", "SMTP email")}
        ${flag(Boolean(config.adminPassword), "Admin console", "Admin console")}
      </div>
      <h3>AI / voice / camera</h3>
      <div class="flags" style="margin-bottom:0.75rem">
        ${flag(Boolean(config.geminiApiKey), `Gemini chat · ${config.geminiModel}`, "Gemini chat")}
        ${flag(Boolean(config.geminiApiKey), `Gemini overview · ${config.geminiOverviewModel}`, "Gemini overview")}
        ${flag(Boolean(config.geminiApiKey), `Gemini Live · ${config.geminiLiveModel}`, "Gemini Live")}
        ${flag(Boolean(config.xaiApiKey), `xAI TTS · ${config.xaiTtsVoice}`, "xAI TTS")}
        ${flag(Boolean(config.presageApiKey), "Presage camera", "Presage camera")}
      </div>
      <h3>Ollama (API host)</h3>
      <div class="flags" style="margin-bottom:0.75rem">
        ${flag(Boolean(config.ollamaBaseUrl), config.ollamaBaseUrl ?? "Ollama", "Ollama")}
        ${flag(Boolean(config.ollamaBaseUrl), `Lock-in · ${config.ollamaModel}`, `Lock-in · ${config.ollamaModel}`)}
        ${flag(Boolean(config.ollamaBaseUrl), `Vision · ${config.ollamaVisionModel}`, `Vision · ${config.ollamaVisionModel}`)}
        ${flag(Boolean(config.ollamaBaseUrl), `Chat · ${config.ollamaChatModel}`, `Chat · ${config.ollamaChatModel}`)}
        <span class="pill soft">LOCAL_CHAT_PROVIDER=${escapeHtml(config.localChatProvider)}</span>
        ${flag(Boolean(config.coachApiToken), "Coach token", "Coach token")}
      </div>
      <p class="muted" style="margin:0;font-size:0.82rem">Public base · <code>${escapeHtml(config.publicBaseUrl)}</code></p>
    </div>

    <div class="panel">
      <h2>Recent users</h2>
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
    ${headerBar(u.email ?? u.name ?? "User", `User detail · <a class="link" href="/admin">← Overview</a> · <a class="link" href="/admin/api/users/${escapeHtml(u.id)}">JSON</a>`)}
    ${nav("users")}

    <div class="panel">
      <h2>Identity · users</h2>
      <dl class="kv">
        <dt>id</dt><dd><code>${escapeHtml(u.id)}</code></dd>
        <dt>email</dt><dd>${escapeHtml(u.email ?? "—")} ${u.email_verified ? '<span class="pill ok">verified</span>' : '<span class="pill soft">unverified</span>'}</dd>
        <dt>name</dt><dd>${escapeHtml(u.name ?? "—")}</dd>
        <dt>google_sub</dt><dd><code>${escapeHtml(u.google_sub ?? "—")}</code></dd>
        <dt>picture</dt><dd>${u.picture ? `<a class="link" href="${escapeHtml(u.picture)}" target="_blank" rel="noreferrer">open</a>` : "—"}</dd>
        <dt>calendar_connected</dt><dd>${u.calendar_connected ? '<span class="pill ok">true</span>' : '<span class="pill bad">false</span>'}</dd>
        <dt>google_refresh_token</dt><dd>${u.has_google_refresh_token ? '<span class="pill ok">present</span>' : '<span class="pill bad">missing</span>'}</dd>
        <dt>created_at</dt><dd>${escapeHtml(u.created_at ?? "—")}</dd>
        <dt>last_login_at</dt><dd>${escapeHtml(u.last_login_at ?? "—")}</dd>
        <dt>refresh_tokens</dt><dd>${detail.tokens.active} active · ${detail.tokens.revoked} revoked · ${detail.tokens.total} total</dd>
      </dl>
    </div>

    <div class="panel">
      <h2>Profile · user_profiles</h2>
      ${detail.profile ? profilePanel(detail.profile) : `<p class="muted" style="margin:0">No profile row.</p>`}
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
      <h2>Drive cache (${detail.driveCache.length}) · drive_file_cache</h2>
      ${rowsTable(detail.driveCache as unknown as Record<string, unknown>[])}
    </div>

    <div class="panel">
      <h2>School digests (${detail.schoolDigests.length}) · school_digests</h2>
      ${digestsPanel(detail.schoolDigests)}
    </div>

    <div class="panel">
      <h2>Danger zone</h2>
      <p class="sub">Permanently deletes this user row and all synced data (same as the app’s Delete everything forever).</p>
      <form method="post" action="/admin/users/${escapeHtml(u.id)}/delete" onsubmit="return confirm('Delete this user forever from the server?');">
        <button class="btn" type="submit" style="background:#8b1e1e;border-color:#8b1e1e">Delete user forever</button>
      </form>
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
        <a class="btn ghost" href="/admin/api/data/${escapeHtml(result.table)}">JSON</a>
      </div>
      ${rowsTable(result.rows, { linkUserIds: result.table === "users" })}
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

  if (method === "GET" && path === "/admin/favicon.png") {
    sendAdminAsset(res, SHIP_ICON_PNG, "image/png");
    return true;
  }
  if (method === "GET" && path === "/admin/favicon.ico") {
    sendAdminAsset(res, FAVICON_ICO, "image/x-icon");
    return true;
  }

  if (!deps.config.adminPassword) {
    if (method === "GET" && path === "/admin") {
      sendHtml(
        res,
        503,
        shell(
          "Admin unavailable",
          `${brandHeading("Admin unavailable")}<p class="sub">This console is not enabled on this server.</p>`,
        ),
      );
      return true;
    }
    throw new HttpError(503, "admin_not_configured", "Admin is unavailable.");
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
    if (deps.limiter && deps.adminLoginRule) {
      const ip = clientIp(req, deps.config.trustProxy);
      const nowMs = (deps.now ?? (() => new Date()))().getTime();
      const result = deps.limiter.hit("admin-login", ip, deps.adminLoginRule, nowMs);
      if (!result.ok) {
        console.warn("[admin] login rate-limited for", ip);
        throw rateLimited(result.retryAfterSeconds, "admin_login_rate_limited");
      }
    }
    const password = await readPassword(req);
    if (!passwordsMatch(password, deps.config.adminPassword)) {
      console.warn("[admin] failed login attempt");
      sendHtml(res, 401, loginPage("Incorrect password."));
      return true;
    }
    setAdminCookie(res, deps.config);
    res.writeHead(303, { Location: "/admin", "Cache-Control": "no-store" });
    res.end();
    return true;
  }

  if (method === "POST" && path === "/admin/logout") {
    clearAdminCookie(res, deps.config);
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

  const userDeleteMatch = path.match(/^\/admin\/users\/([^/]+)\/delete$/);
  if (method === "POST" && userDeleteMatch) {
    requireAdmin(req, deps.config);
    const id = decodeURIComponent(userDeleteMatch[1] ?? "");
    if (!UUID_RE.test(id)) {
      throw new HttpError(400, "invalid_user_id", "User id must be a UUID.");
    }
    const detail = await deps.store.adminUserDetail(id);
    if (!detail) throw new HttpError(404, "user_not_found", "No user with that id.");
    // Best-effort Google revoke before wipe (same posture as DELETE /v1/me/data).
    try {
      const { refreshToken } = await deps.store.getCalendarConnection(id);
      if (refreshToken) {
        await fetch("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: refreshToken }),
          signal: AbortSignal.timeout(5000),
        });
      }
    } catch {
      // Local clear must still succeed if Google is unreachable.
    }
    await deps.store.clearUserData(id, new Date());
    res.writeHead(303, { Location: "/admin", "Cache-Control": "no-store" });
    res.end();
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
