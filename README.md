# Waypoint API

Account server for the Waypoint desktop app. **Desktop login is Google OAuth only** — Google identity is upserted to a Waypoint `user.id`, then the app stores a JWT. A one-time email code path remains for API/dev tests only (not exposed in the desktop UI). Secrets (Google client secret, Gemini, xAI, Presage, admin password) live **only** on this API. The desktop uses its Waypoint access token for memory, tasks, calendar/Drive, Copilot chat, and coach proxy calls.

**Production / shared server (HTTPS, nginx, systemd, TigerData, Mac release builds):** see **[DEPLOY.md](./DEPLOY.md)**. This README is the **local developer** path.

## Run your own API (beta)

Run this server on **your** machine (or VPS) with **your own** keys. Nothing is shared with the production Waypoint host.

1. **Node 22+, install, copy env**

   ```bash
   cd BigRedHacksProjectBackend
   node -v                    # must be v22+
   npm install
   cp .env.example .env
   ```

2. **Required keys checklist** (paste into `.env`; details in [Environment variables](#environment-variables))

   | Key | Required for beta | Notes |
   |---|---|---|
   | `SESSION_SECRET` | **yes** | ≥32 characters — `openssl rand -base64 32` |
   | `GOOGLE_CLIENT_ID` | **yes** | Web application OAuth client (not Desktop) |
   | `GOOGLE_CLIENT_SECRET` | **yes** | Server-only |
   | `GEMINI_API_KEY` | **yes** (Copilot / Live) | Unset → chat may fall back to Ollama only |
   | `XAI_API_KEY` | **yes** (Talk / Live TTS) | Live voice has no macOS `say` fallback — [console.x.ai](https://console.x.ai/) |
   | `PUBLIC_BASE_URL` | **yes** | Origin for OAuth redirects (e.g. `http://127.0.0.1:8787` locally; **no trailing slash**) |
   | `PRESAGE_API_KEY` | optional | Camera vitals on `POST /v1/camera/observe`; presence still works without it |
   | `DATABASE_URL` | optional | Empty → file store (`data/store.json`); set for Postgres / TigerData |

   Google redirect URIs on that Web client must use the same `PUBLIC_BASE_URL` — see [Google Cloud client (local OAuth)](#google-cloud-client-local-oauth).

3. **`PUBLIC_BASE_URL` ↔ desktop `waypoint_api_base`** — must be **identical** (scheme + host + port, no trailing slash). In the Mac repo [BigRedHacksProject](https://github.com/legitminh/BigRedHacksProject), edit `src-tauri/secrets.toml`: set `waypoint_api_base` to the same value as `PUBLIC_BASE_URL`, and `local_llm_base` to `{PUBLIC_BASE_URL}/v1/coach` (e.g. `http://127.0.0.1:8787/v1/coach`). See also [Pairing with the desktop app](#pairing-with-the-desktop-app).

4. **Start the API and health-check**

   ```bash
   npm start                  # single process (beta / simple)
   # or: npm run dev          # watch mode while hacking on this repo
   curl -sS http://127.0.0.1:8787/health
   # expect: {"ok":true,"service":"waypoint-api","storage":"file"}
   #         or "storage":"postgres" when DATABASE_URL is set
   ```

   Restart after any `.env` change. Optional: `GET /v1/status` (with or without a JWT) for Gemini / Ollama / xAI / Presage probes — [docs/STATUS.md](./docs/STATUS.md).

5. **Rebuild or relaunch the Mac app** — after editing `secrets.toml`, from the desktop repo run `npm run app:dev` (local HTTP), `npm run app:build:debug`, or `npm run app:build` (release needs public `https://` base). A mismatch between `PUBLIC_BASE_URL` and `waypoint_api_base` breaks Google redirects, JWT calls, coach proxy, Live WebSocket, and Settings → Connection.

Desktop companion: [BigRedHacksProject](https://github.com/legitminh/BigRedHacksProject).

## Prerequisites

- **Node.js ≥ 22** (`engines.node` in `package.json`). Check with `node -v`.
- **npm** (ships with Node).
- Optional but recommended for Copilot fallback + lock-in coach: [Ollama](https://ollama.com/download) on the same machine.
- Optional: TigerData / Postgres URL when you want multi-device storage instead of the local file store.

## Quick start (local)

```bash
cd BigRedHacksProjectBackend
node -v                    # must be v22+
npm install
cp .env.example .env
```

There is **no** committed `.env` with real keys. Generate a session secret and paste it into `.env`:

```bash
openssl rand -base64 32    # → SESSION_SECRET (≥32 characters)
```

Minimum for Google sign-in: `SESSION_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (Web client below). Leave `DATABASE_URL` empty for file storage. See [Environment variables](#environment-variables) for the full list.

```bash
npm run dev                # watch mode (restarts on file changes)
# or: npm start            # single process, no watch
```

Health check (default bind `BIND_HOST:PORT` → `http://127.0.0.1:8787`):

```bash
curl -sS http://127.0.0.1:8787/health
# expect: {"ok":true,"service":"waypoint-api","storage":"file"}
#         or "storage":"postgres" when DATABASE_URL is set
```

After any `.env` change, **restart** the process (`npm run dev` restarts on code edits; env changes still need a manual restart).

## Environment variables

Copy from `.env.example`. Values below are **placeholders / defaults only** — never commit real secrets.

### Server bind & public URL

| Variable | Required | Default / example | Notes |
|---|---|---|---|
| `PORT` | no | `8787` | HTTP listen port. |
| `BIND_HOST` | no | `127.0.0.1` | Keep loopback for local + same-host reverse proxy. Use `0.0.0.0` only when the API is on a private network behind a separate proxy, and firewall `:8787`. |
| `PUBLIC_BASE_URL` | yes (for OAuth) | `http://127.0.0.1:8787` | Origin clients and Google redirects use. **No trailing slash.** Must match desktop `waypoint_api_base`. Local: `http://127.0.0.1:8787`. Production: `https://…` — see [DEPLOY.md](./DEPLOY.md). |
| `WAYPOINT_CORS_ORIGINS` | no | _(empty)_ | Extra browser origins, comma-separated. `localhost`, `127.0.0.1`, and `tauri://localhost` are already allowed. |
| `TRUST_PROXY` | no | unset (off) | Set `1` **only** behind a reverse proxy you control so rate limits use `X-Forwarded-For`. Never enable on a public bind without a trusted proxy. |
| `NODE_ENV` | no | unset | Set `production` on real deploys: hardens email OTP (requires SMTP) and related defaults. |

### Auth & tokens

| Variable | Required | Default / example | Notes |
|---|---|---|---|
| `SESSION_SECRET` | **yes** for real login | _(generate)_ | HMAC secret for Waypoint JWTs. **≥32 characters.** `openssl rand -base64 32`. Missing/short → `503 session_secret_missing`. |
| `GOOGLE_CLIENT_ID` | **yes** for Google login | _(from Cloud Console)_ | **Web application** OAuth client id. Never put this in the Mac app for API redirects. |
| `GOOGLE_CLIENT_SECRET` | **yes** for Google login | _(from Cloud Console)_ | Web client secret. Server-only. |
| `ACCESS_TOKEN_TTL_SECONDS` | no | `900` | Access JWT lifetime (15 minutes). |
| `REFRESH_TOKEN_TTL_SECONDS` | no | `2592000` | Refresh token lifetime (30 days). |
| `ADMIN_PASSWORD` | no | _(empty)_ | Password for local HTML `/admin`. Generate e.g. `openssl rand -base64 48 \| tr -dc A-Za-z0-9 \| head -c 32`. Cookie `wp_admin` is `HttpOnly; SameSite=Strict` and gets `Secure` when `PUBLIC_BASE_URL` is `https://`. |

### Storage

| Variable | Required | Default / example | Notes |
|---|---|---|---|
| `DATABASE_URL` | no | _(empty = file)_ | Empty → `data/store.json` (`GET /health` → `"storage":"file"`). Set to a Postgres / TigerData URL for durable multi-user storage (`"storage":"postgres"`). Schema applied from `src/db/schema.sql` on startup. Example shape: `postgresql://USER:PASSWORD@HOST:PORT/DB?sslmode=require`. |

See [File vs Postgres storage](#file-vs-postgres-storage).

### Email OTP (dev / API tests only)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `SMTP_HOST` | no | _(empty)_ | Leave **all five** blank locally → codes append to `data/outbox.jsonl` (gitignored). |
| `SMTP_PORT` | no | _(empty)_ | |
| `SMTP_USER` | no | _(empty)_ | |
| `SMTP_PASS` | no | _(empty)_ | |
| `MAIL_FROM` | no | _(empty)_ | Set all five to send codes over SMTP. In `NODE_ENV=production`, email sign-in is refused unless SMTP is fully configured. |

### Gemini (Google AI)

| Variable | Required | Default / example | Notes |
|---|---|---|---|
| `GEMINI_API_KEY` | for Copilot / Live | _(empty)_ | Long-lived key; server-only. Unset → Copilot can fall back to Ollama if configured. |
| `GEMINI_MODEL` | no | `gemini-3.5-flash-lite` | Copilot / companion **HTTP text** (`POST /v1/gemini/chat`, `/v1/companion/chat`). |
| `GEMINI_OVERVIEW_MODEL` | no | `gemini-3.5-flash` | School digest / deep Drive overview REST. |
| `GEMINI_LIVE_MODEL` | no | `gemini-3.8-live` | Talk / Live **voice** WebSocket only (`WS /v1/companion/live`). Not used for HTTP Copilot. |
| `LIVE_ALLOW_QUERY_TOKEN` | no | `0` | `0` rejects `?access_token=` / `?token=` on Live (preferred). Desktop uses `Sec-WebSocket-Protocol: bearer.<jwt>`. |
| `LITE_DEPTH_USE_LLM` | no | unset (off) | Set `1` to run Flash-Lite structuring on Drive deep-brief excerpts (uses more Gemini quota). |
| `LOCAL_CHAT_PROVIDER` | no | `gemini` | `gemini` / `cloud` → Gemini first, silent Ollama fallback on quota/outage. `ollama` / `llama` / `local` → always Ollama; never Gemini for chat. |

**Gemini surfaces (do not conflate):**

| Surface | Env | API | Notes |
|---|---|---|---|
| Copilot / companion **text** | `GEMINI_MODEL` | REST `generateContent` via `POST /v1/gemini/chat` + `/v1/companion/chat` | A Gemini **429 on chat is REST quota**, not a Live WebSocket failure. |
| School digest / deep Drive | `GEMINI_OVERVIEW_MODEL` | REST overview | Once/day digest + optional Lite depth (`LITE_DEPTH_USE_LLM=1`). |
| Talk / Live **voice** | `GEMINI_LIVE_MODEL` + **`XAI_API_KEY`** | `WS /v1/companion/live` | Live needs Grok TTS; heads-up TTS can fall back to macOS `say`. |

### xAI / Grok

| Variable | Required | Default / example | Notes |
|---|---|---|---|
| `XAI_API_KEY` | for Live + brag sheets | _(empty)_ | Study heads-up TTS (`POST /v1/voice/tts`), Live speak, and mission brag sheet (`POST /v1/concept-map` → Grok Imagine). Server-only. Get a key from [console.x.ai](https://console.x.ai/). |
| `XAI_TTS_VOICE` | no | `eve` | Built-in voice id (`eve`, `ara`, `rex`, `sal`, …). |

### Presage (camera accountability)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `PRESAGE_API_KEY` | no | _(empty)_ | Vitals for `POST /v1/camera/observe`. Server-only — desktop uploads clips here and never holds this key on that path. Unset → presence heuristics only (`vitals=null`). |

### Ollama / coach proxy

| Variable | Required | Default / example | Notes |
|---|---|---|---|
| `OLLAMA_BASE_URL` | no | `http://127.0.0.1:11434` | Ollama on the **API host**. Omit to use the default; set empty (`OLLAMA_BASE_URL=`) to disable the coach proxy (`503 ollama_not_configured`). |
| `OLLAMA_MODEL` | no | `qwen2.5:0.5b` | Fast lock-in coach (`ollama pull qwen2.5:0.5b`). |
| `OLLAMA_VISION_MODEL` | no | `moondream` | Rare local vision (`ollama pull moondream`). |
| `OLLAMA_CHAT_MODEL` | no | `qwen2.5:7b` | Copilot local path / Gemini fallback (`ollama pull qwen2.5:7b`). |
| `OLLAMA_CHAT_NUM_CTX` | no | `16384` | Context window for local Copilot. |
| `OLLAMA_ALLOWED_MODELS` | no | _(empty)_ | Extra models `/v1/coach/api/generate` may run (comma-separated). The three configured models above are always allowed. |
| `COACH_API_TOKEN` | no | _(empty)_ | Optional shared Bearer for `/v1/coach/*`. `openssl rand -hex 24`. Signed-in Waypoint JWTs also work. |

## File vs Postgres storage

| Mode | `DATABASE_URL` | Data location | `GET /health` | When to use |
|---|---|---|---|---|
| **File** | unset / empty | `data/store.json` (+ `data/outbox.jsonl` for local email codes) | `"storage":"file"` | Solo laptop / hackathon laptop. Single machine only. |
| **Postgres** | TigerData or any Postgres URL | remote DB; tables from `src/db/schema.sql` on boot | `"storage":"postgres"` | Multi-device sync, shared team server, production. |

TigerData sketch: create a service → copy the connection string once → paste into `DATABASE_URL` → restart → confirm `/health` shows `postgres`.

### Connection status (`GET /v1/status`)

Desktop **Settings → Connection** calls `GET /v1/status` — aggregated live probes for Gemini, Ollama, Google, account, Copilot chat provider, companion Live, xAI TTS, Presage, and storage. Auth is optional (JWT enriches account + Calendar/Drive). Probe results are cached ~300s (`cache_ttl_seconds` in the payload). Process liveness alone remains at `GET /health`. Full indicator meanings and critical vs optional rows: **[docs/STATUS.md](./docs/STATUS.md)**.

### Camera observe / accountability

Contract and nudge policy: **[docs/CAMERA-ACCOUNTABILITY.md](./docs/CAMERA-ACCOUNTABILITY.md)** (`POST /v1/camera/observe`). Desktop may use **local live face** (continuous Vision / yaw / brightness on the Mac) as the primary presence path; the API still serves sparse clip observes and optional **Presage** vitals when `PRESAGE_API_KEY` is set and the client uploads video without posting local `face_detected`. Presage key stays on this server only.

### Live voice / TTS (`XAI_API_KEY`)

Talk / Live (`WS /v1/companion/live`) needs **`XAI_API_KEY`** (Grok TTS) in addition to Gemini Live credentials — Live cannot fall back to macOS `say`. Heads-up TTS (`POST /v1/voice/tts`) may fall back to `say` when xAI is unset; check `companion_live` / `xai_tts` rows on `GET /v1/status`. The same key draws the mission brag sheet (`POST /v1/concept-map`).

### Restart limitations (single process)

In-flight Google sign-in polls, **calendar-connect** polls (`/v1/google/calendar/start` → `/poll`), and **camera presence ladder / stress cooldowns** live in process memory. A restart drops them; the app simply starts the connect flow again (camera may re-nag the first away/stress rung). Already-completed grants and tokens are stored durably (file or Postgres). Run one API process (no horizontal scaling) unless these are moved to shared storage. After any `.env` or code change, **restart** the process.

**Admin console:** the `wp_admin` cookie is `HttpOnly; SameSite=Strict` and gets `Secure` automatically when `PUBLIC_BASE_URL` starts with `https://`.

## Testing

```bash
npm test
```

Runs Node’s built-in test runner on `test/*.test.ts` (needs Node ≥ 22; uses `--experimental-strip-types`). No extra test runner install. Suites are self-contained: they spin up ephemeral servers / temp stores and inject fakes where needed (email mailer, Gemini/Presage/Ollama fetch stubs) — they do **not** send real mail or burn live API quota.

| Suite | Covers |
|---|---|
| `auth.test.ts` | Google start/poll/callback, refresh rotation, `/v1/me`, sign-out, CORS localhost |
| `email-auth.test.ts` | Email OTP start/verify (injected mailer; no SMTP) |
| `google-token.test.ts` | Google disconnect, `DELETE /v1/me/data`, pending-file permissions |
| `status.test.ts` | `GET /v1/status` probes, quota/Ollama rows, auth enrichment, cache TTL |
| `product.test.ts` | Memory/tasks/sessions/notes, companion + Gemini chat fallbacks, calendar, digest hooks |
| `camera-observe.test.ts` / `camera-presence.test.ts` | Observe HTTP contract + presence/nudge ladders |
| `presage.test.ts` | Vitals mapping, stress thresholds, safe upload URL |
| `coach.test.ts` | `/v1/coach/*` auth + Ollama proxy |
| `companion-live.test.ts` / `live-chat.test.ts` / `audio-protocol.test.ts` | Live setup, isolated Live chat, WP1 PCM framing |
| `voice-tts.test.ts` / `grok-tts.test.ts` | `POST /v1/voice/tts` + Grok stream/queue protocol (`XAI_API_KEY`) |
| `gemini-chat.test.ts` / `localChat.test.ts` | REST chat errors/quota; `LOCAL_CHAT_PROVIDER` parsing |
| `concept-map.test.ts` | Brag-sheet prompt / validation |
| `school-digest.test.ts` / `liteDepth.test.ts` / `drive-*.test.ts` | Digest caching, Drive extract/cache/search/brief |
| `calendar-window.test.ts` | Agenda window / timezone edges |
| `admin.test.ts` / `abuse-shields.test.ts` | Admin login; rate limits / client IP |

## Google Cloud client (local OAuth)

Create a **Web application** OAuth client. A Desktop-type client (or any client baked into the Mac app) is a different credential and will **not** work as this API’s redirect target.

1. Open [Google Cloud Console](https://console.cloud.google.com/) and select (or create) the Waypoint project.
2. **APIs & Services → OAuth consent screen**. App name `Waypoint`. Add the Google accounts that will sign in while the app is in testing.
3. Enable **Google Calendar API** and **Google Drive API**.
4. Scopes: desktop **sign-in is one bundled consent**: `openid email profile` + `https://www.googleapis.com/auth/calendar.events` + `https://www.googleapis.com/auth/drive.readonly`. Add them on the consent screen. The separate calendar connect flow (`/v1/google/calendar/start`) re-requests Calendar + Drive as a second consent (re-connect / incremental).
5. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
6. Application type: **Web application**. Name: `Waypoint API`.
7. Authorized redirect URIs for **local** (`PUBLIC_BASE_URL=http://127.0.0.1:8787`):

```text
http://127.0.0.1:8787/v1/auth/google/callback
http://127.0.0.1:8787/v1/google/calendar/callback
```

Those URIs are `{PUBLIC_BASE_URL}` + `/v1/auth/google/callback` and `/v1/google/calendar/callback`. If you change `PUBLIC_BASE_URL` (or deploy HTTPS), add matching URIs on the same client and restart the server. Production redirect URIs: **[DEPLOY.md](./DEPLOY.md)**.

8. Copy the client id and client secret into `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

Blank Google credentials → `503 google_not_configured` on `POST /v1/auth/google/start`.

## Coach / Ollama (desktop lock-in)

Ollama runs **on this API host**, not on end-user Macs. The desktop sets `local_llm_base` to `{PUBLIC_BASE_URL}/v1/coach` and sends a user JWT (or optional `COACH_API_TOKEN`).

```bash
# On the API machine (install from https://ollama.com/download if needed)
ollama serve
ollama pull qwen2.5:0.5b    # lock-in coach (OLLAMA_MODEL)
ollama pull moondream       # rare local vision (OLLAMA_VISION_MODEL)
ollama pull qwen2.5:7b      # Copilot fallback / LOCAL_CHAT_PROVIDER=ollama (OLLAMA_CHAT_MODEL)

# Confirm tags
curl -s http://127.0.0.1:11434/api/tags | head
```

Typical `.env` for local coach:

```env
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen2.5:0.5b
OLLAMA_VISION_MODEL=moondream
OLLAMA_CHAT_MODEL=qwen2.5:7b
# COACH_API_TOKEN=   # optional; openssl rand -hex 24
```

| Method | Path | Proxies to |
|---|---|---|
| `GET` | `/v1/coach/api/tags` | `GET {OLLAMA_BASE_URL}/api/tags` |
| `POST` | `/v1/coach/api/generate` | `POST {OLLAMA_BASE_URL}/api/generate` |
| `GET` | `/v1/coach/health` | tags probe + `{ ok, ollama }` |

Auth: matching `COACH_API_TOKEN`, **or** a signed-in Waypoint access token. Generate bodies are capped at 4 MiB. CORS allows `tauri://localhost`, `http(s)://tauri.localhost`, and `http(s)://localhost` / `127.0.0.1`. Extra origins: `WAYPOINT_CORS_ORIGINS` (comma-separated). Errors: `503 ollama_not_configured` if `OLLAMA_BASE_URL` is blank; `502 ollama_unreachable` if Ollama is down or times out.

## Production

For HTTPS, nginx/Caddy, systemd, TigerData, production Google redirect URIs, and pointing Mac release builds at a public API, follow **[DEPLOY.md](./DEPLOY.md)** end-to-end. Do not ship apps with `PUBLIC_BASE_URL=http://127.0.0.1:8787`.

## Pairing with the desktop app

| This API (`.env`) | Desktop (`src-tauri/secrets.toml`) |
|---|---|
| `PUBLIC_BASE_URL` | `waypoint_api_base` — **must be identical** (scheme + host + port, no trailing slash mismatch) |
| `{PUBLIC_BASE_URL}/v1/coach` | `local_llm_base` (coach / Ollama proxy) |

Google OAuth redirect URIs on the Web client must use the same `PUBLIC_BASE_URL`. After changing either side, restart the API and rebuild/relaunch the Mac app so secrets and redirects stay aligned.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Google login never completes / `google_not_configured` | Missing `GOOGLE_CLIENT_*`, wrong redirect URI, or `PUBLIC_BASE_URL` ≠ desktop `waypoint_api_base` | Fill Web client secrets; add `{PUBLIC_BASE_URL}/v1/auth/google/callback` (and calendar callback); match desktop base; restart API |
| Poll stuck / lost after restart mid-login | In-memory OAuth polls cleared on process restart | Start Google sign-in again (tokens already issued remain durable) |
| Gemini chat / status shows Quota / 429 | Free-tier REST RPM/RPD exhausted (`GEMINI_API_KEY`) | Wait for quota reset; rely on Ollama fallback (`OLLAMA_CHAT_MODEL`) or set `LOCAL_CHAT_PROVIDER=ollama`; prefer Connection panel over hammering chat |
| Coach / lock-in local judge fails; `502 ollama_unreachable` | Ollama not running on the API host, wrong `OLLAMA_BASE_URL`, or models not pulled | `ollama serve` + pull `qwen2.5:0.5b` / `moondream` / `qwen2.5:7b`; check `GET /v1/coach/health` |
| Camera vitals empty / Presage Unavailable on status | `PRESAGE_API_KEY` unset or Presage transport failed | Set key for optional vitals; desktop local live face still covers presence — see [CAMERA-ACCOUNTABILITY.md](./docs/CAMERA-ACCOUNTABILITY.md) |
| Talk / Live silent or `xai_tts` warn | Missing `XAI_API_KEY` | Set key; Live hard-requires Grok TTS (heads-ups may use macOS `say` without it) |
| CORS errors from webview / wrong bind | Origin not allowed, or `BIND_HOST` not reachable from the Mac | Default CORS covers Tauri/localhost; add `WAYPOINT_CORS_ORIGINS` if needed. Local-only: `BIND_HOST=127.0.0.1`. LAN/deploy: bind `0.0.0.0` behind a reverse proxy and set `PUBLIC_BASE_URL` to the public HTTPS origin |

## Calling the API from Waypoint

Base URL: whatever you set as `PUBLIC_BASE_URL` / desktop `waypoint_api_base` (default local `http://127.0.0.1:8787`). Call it from Rust (`reqwest` is already in the app), the same way `connect_google` opens the system browser today. The webview may also call it: `http://localhost`, `http://127.0.0.1`, and `tauri://localhost` are allowed CORS origins.

Replace the placeholder `sign_in_waypoint` / `sign_out_waypoint` commands. Calendar connect below replaces the desktop Google client secret for events Waypoint creates. The field-by-field contract is `specs.md`.

Every error body looks like:

```json
{ "error": { "code": "unauthorized", "message": "Sign in required." } }
```

### 1. Start Google sign-in

`POST /v1/auth/google/start` with no body.

```bash
curl -s -X POST http://127.0.0.1:8787/v1/auth/google/start
```

```json
{
  "authorization_url": "https://accounts.google.com/o/oauth2/v2/auth?...",
  "state": "...",
  "poll_token": "...",
  "expires_in": 600
}
```

`503` `google_not_configured` means the Google client is blank. `503` `session_secret_missing` means `SESSION_SECRET` is missing or shorter than 32 characters.

Open `authorization_url` in the system browser (`open::that` in the Tauri app). Do not send `poll_token` to Google. Keep it in the app until the poll finishes. The pending login lasts 10 minutes.

### 2. Poll until the browser finishes

`GET /v1/auth/google/poll?poll_token=...` about twice a second.

Still waiting:

```json
{ "status": "pending", "expires_in": 540 }
```

Success, returned **once**:

```json
{
  "status": "complete",
  "token_type": "Bearer",
  "access_token": "<jwt>",
  "refresh_token": "<opaque>",
  "expires_in": 900,
  "user": {
    "id": "6d0f0a2e-1c2b-4a7e-9c1d-0b5a6e7f8091",
    "email": "student@cornell.edu",
    "email_verified": true,
    "name": "Student",
    "picture": "https://lh3.googleusercontent.com/..."
  }
}
```

Google cancelled or denied:

```json
{ "status": "error", "error": { "code": "google_denied", "message": "Google sign-in was cancelled." } }
```

A token exchange failure uses `google_exchange_failed`. A second read of a finished poll is `404` `poll_not_found`. An attempt older than 10 minutes is `410` `poll_expired`; start again.

Save `access_token`, `refresh_token`, the expiry (`now + expires_in`), and `user` in the Waypoint data directory (the same place as today’s `waypoint_session.json`). Treat both tokens like passwords: do not log them, and do not put them in `secrets.toml`.

The access token is a JWT signed by this server. It expires after `expires_in` seconds (15 minutes by default). The refresh token lasts 30 days by default.

### 3. Call an authenticated route

```bash
curl -s http://127.0.0.1:8787/v1/me \
  -H "Authorization: Bearer ACCESS_TOKEN"
```

`200` is the same `user` object. `401` `unauthorized` means the header is missing, the token is expired, or the signature is wrong.

### 4. Refresh

When a call returns `401`, or a little before `expires_in` runs out, exchange the refresh token once and retry the original call:

```bash
curl -s -X POST http://127.0.0.1:8787/v1/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{"refresh_token":"REFRESH_TOKEN"}'
```

```json
{
  "token_type": "Bearer",
  "access_token": "<new jwt>",
  "refresh_token": "<new opaque>",
  "expires_in": 900
}
```

Replace **both** saved tokens. The refresh token you just sent is dead. Sending it again returns `401` `refresh_reuse` and revokes every refresh token for that user, which signs them out on every device. If that happens, run the Google sign-in flow again.

`401` `invalid_refresh` means the token is unknown, expired, or already revoked. Sign in again.

### 5. Sign out

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST http://127.0.0.1:8787/v1/auth/sign-out \
  -H "Authorization: Bearer ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"all":true}'
```

`204` with an empty body. `all: true` revokes every refresh token for the user. To revoke only one device, send `{ "refresh_token": "..." }` instead. Then delete the saved tokens locally.

The access token itself keeps working until it expires. Drop it locally on sign-out anyway.

### 6. Study companion Live (preferred)

During a lock-in, the desktop opens a **thin** WebSocket to this API only:

`WS /v1/companion/live?access_token=ACCESS_TOKEN`

Protocol mirrors [gemini_live_demo](https://github.com/legitminh/gemini_live_demo): `start` → mic `audio` / typed `text` / `barge` / `stop`. This server holds `GEMINI_API_KEY`, opens Gemini Live upstream (`GEMINI_LIVE_MODEL`), and streams transcripts + audio back via **Grok TTS (`XAI_API_KEY` required — no `say` fallback for Live)**. Optional study context is sent on `start`. Typed fallback (no Live): `POST /v1/companion/chat`.

## Rust sketch

This is the shape of a Tauri command that replaces `sign_in_waypoint`. It is not wired into the app in this branch.

```rust
const API: &str = "http://127.0.0.1:8787";

#[derive(serde::Deserialize)]
struct StartBody {
    authorization_url: String,
    poll_token: String,
}

#[derive(serde::Deserialize)]
struct PollBody {
    status: String,
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
    user: Option<serde_json::Value>,
    error: Option<ApiErrorBody>,
}

#[derive(serde::Deserialize)]
struct ApiErrorBody {
    message: String,
}

pub async fn sign_in_with_google() -> Result<PollBody, String> {
    let client = reqwest::Client::new();
    let start: StartBody = client
        .post(format!("{API}/v1/auth/google/start"))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    open::that(&start.authorization_url).map_err(|e| e.to_string())?;

    // 10 minutes, matching the pending login lifetime.
    for _ in 0..1200 {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let poll: PollBody = client
            .get(format!("{API}/v1/auth/google/poll"))
            .query(&[("poll_token", &start.poll_token)])
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;

        if poll.status == "pending" {
            continue;
        }
        if poll.status == "error" {
            return Err(poll.error.map(|e| e.message).unwrap_or_else(|| "Google sign-in failed".into()));
        }
        return Ok(poll);
    }
    Err("Google sign-in timed out".into())
}
```

Persist `access_token` and `refresh_token` from the `complete` poll the same way `auth.rs` writes `waypoint_session.json`. On later commands, send `Authorization: Bearer <access_token>`. On `401`, `POST /v1/auth/refresh`, store the new pair, and retry once.

## Email login

`POST /v1/auth/email/start` asks Waypoint to email a one-time code. There is no password.

```bash
curl -s -X POST http://127.0.0.1:8787/v1/auth/email/start \
  -H "Content-Type: application/json" \
  -d '{"email":"student@cornell.edu"}'
```

When the address is syntactically valid, the response is always the same, whether or not an account already exists:

```json
{ "status": "sent", "expires_in": 600 }
```

The body never includes the code. `400` `invalid_email` means the address is not a valid email. The code expires in 10 minutes. Starting again for the same address replaces the previous code.

`POST /v1/auth/email/verify` exchanges that code for Waypoint tokens:

```bash
curl -s -X POST http://127.0.0.1:8787/v1/auth/email/verify \
  -H "Content-Type: application/json" \
  -d '{"email":"student@cornell.edu","code":"123456"}'
```

Success has the same fields as a completed Google poll, without `status`:

```json
{
  "token_type": "Bearer",
  "access_token": "<jwt>",
  "refresh_token": "<opaque>",
  "expires_in": 900,
  "user": {
    "id": "6d0f0a2e-1c2b-4a7e-9c1d-0b5a6e7f8091",
    "email": "student@cornell.edu",
    "email_verified": true,
    "name": null,
    "picture": null
  }
}
```

Save `access_token`, `refresh_token`, the expiry (`now + expires_in`), and `user` the same way as Google sign-in, in the Waypoint data directory (`waypoint_session.json`). Send `Authorization: Bearer <access_token>` on later calls. When it expires, `POST /v1/auth/refresh` with the refresh token and replace both saved tokens. A wrong, expired, or already used code is `401` `invalid_code`.

For local development, leave `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `MAIL_FROM` blank. The server appends one JSON line per code to `data/outbox.jsonl` (gitignored via `data/`). That file is for local dev only. Read `code` from the last line, then call verify. Set all five SMTP variables to send the code by email instead.

## Memory, tasks, calendar, and session recap

Every route below needs `Authorization: Bearer ACCESS_TOKEN`. `specs.md` is the full contract. The client never writes Postgres. Live Gemini voice runs through the server-side proxy (`WS /v1/companion/live`); Copilot text uses REST (see matrix above).

### Desktop Mac v1 surface vs server/future

The shipping Mac app calls a **narrow** authenticated surface. Other product routes stay for admin, tests, or future clients — do not treat them as desktop QA blockers.

| Used by desktop today | Server / admin / future (no Mac callers) |
|---|---|
| Auth Google start/poll/refresh, `DELETE /v1/me/data` | Email OTP auth |
| `GET /v1/status` | `/v1/memory*`, `/v1/voice/health` |
| `POST /v1/gemini/chat`, `/v1/companion/chat`, `WS /v1/companion/live` | `/v1/tasks*`, `/v1/sessions`, `/v1/session-notes*` |
| `/v1/coach/api/*`, `POST /v1/voice/tts`, `POST /v1/concept-map` | Calendar write/agenda, Drive folders |
| Google connect summary, Drive search/inventory/deep-brief | Synonyms: `google/calendar/*` ≈ `google/connect/*` |
| `GET/PUT /v1/study-memory`, school-digest | — |
| `POST /v1/camera/observe` (desktop may prefer local live face; API still serves observe + Presage) | — |

**Lock-in cloud persistence:** the Mac syncs mission history via **`PUT /v1/study-memory` only**. `POST /v1/tasks` and `POST /v1/sessions` are **not** wired from lock-in start/stop (admin / future recap APIs). Camera observe still uses the desktop’s local `session_id`.

### Memory

`GET /v1/memory` returns the profile card. An empty card has empty arrays and interaction defaults (`advise`, `brief`, `sustained_only`, voice on, 10 minute check-in). `updated_at` is `null` until the first save.

`PUT /v1/memory` replaces only the fields you send. Caps are 12 interests, 20 proficiencies, 8 goals, and 8 priorities (`400` `memory_too_large`). Topics match case-insensitively and keep the newest spelling.

`POST /v1/memory/pace` appends one sample (`finished`, `partial`, or `abandoned`). Minutes are integers from 1 to 240. The card's median uses the last 8 finished samples for that topic.

`POST /v1/memory/proficiency` with `{ "topic", "level" }` moves one step (`learning` → `comfortable` → `strong`, or back). A bigger jump is `409` `proficiency_step`. A direct `PUT` may jump.

`GET /v1/memory/pace?topic=heaps` returns the newest samples, default 8.

Load `GET /v1/memory` after sign-in and inject that card into Gemini. Call `PUT` from the profile screen and from a confirmed remember action.

### Tasks (API / future — not used by current Mac lock-in)

`POST /v1/tasks` with `{ "title", "mode", "planned_minutes", "deadline_event_id"? }` creates an `active` task and marks any previous active task `dropped`. `mode` is `advise`, `pair`, or `ask`. `planned_minutes` is 1 to 240.

`GET /v1/tasks/active` returns that task, or `404` `no_active_task`.

`PATCH /v1/tasks/:id` changes `title`, `mode`, or `planned_minutes` without resetting `started_at`.

`POST /v1/tasks/:id/complete` with `{ "outcome", "topic", "break_minutes"? }` sets `ended_at`, stores the outcome, and appends a pace sample. `finished` and `partial` become `done`. `abandoned` becomes `dropped`. `actual_minutes` is the rounded elapsed time minus `break_minutes` (default 0), clamped to 1–240.

### Calendar

Sign-in stays `openid email profile`. Calendar is a second consent.

`POST /v1/google/calendar/start` returns the same `authorization_url`, `state`, `poll_token`, and `expires_in` shape as Google sign-in. Open the URL in the system browser. The redirect is `/v1/google/calendar/callback`.

`GET /v1/google/calendar/poll?poll_token=` matches the login poll. `complete` is `{ "status": "complete", "calendar_connected": true }` and does not issue a new Waypoint token.

`GET /v1/calendar/agenda?days=14` (`days` is 1–30) classifies primary-calendar events into `deadlines` and `blocks`. An event is a deadline when it is all-day or the title matches due, deadline, submit, exam, quiz, prelim, midterm, final, hw, pset, or assignment. `waypoint` is true when the event's private extended property `waypoint` is `1`. `409` `calendar_not_connected` until the consent flow finishes.

`POST /v1/calendar/events` after the student confirms a proposal:

```json
{ "title": "Study: priority queues", "kind": "study_block", "start": "2026-10-03T19:00:00-04:00", "end": "2026-10-03T19:40:00-04:00" }
```

`kind` is `study_block` or `deadline`. A deadline is all-day on the `start` date (`end` is ignored). A study block must last 10 to 240 minutes. Title max 120 characters. The response is the agenda item plus `html_link`.

`PATCH /v1/calendar/events/:id` and `DELETE /v1/calendar/events/:id` work only when `waypoint` is `1`. Otherwise `403` `not_waypoint_event`. Patch sends `start` and `end` for a study block, or `due` for a deadline.

### Session recap (API / future — Mac uses study-memory instead)

`POST /v1/sessions` stores a lock-in recap for future clients / admin. The current desktop does **not** call this; it persists via study-memory:

```json
{
  "task_id": "<id>",
  "started_at": "2026-10-03T18:30:00Z",
  "ended_at": "2026-10-03T19:00:00Z",
  "break_minutes": 0,
  "attention": "recovered",
  "note": "Stuck on the priority queue, then finished push."
}
```

`attention` is `steady`, `recovered`, or `dropped`. This log does not change the profile card. Task completion already wrote the pace sample.

`GET /v1/sessions` returns `{ "sessions": [...] }` newest first.

### Session notes

`POST /v1/session-notes` upserts the Markdown lock-in note for `(user, session_id)`. `GET /v1/session-notes` lists up to 50 newest; `GET /v1/session-notes/:id` returns one. `GET /v1/memory` includes up to five `recent_notes` excerpts. Chat with `purpose=session_note` uses the note writer template (not Copilot). `POST /v1/concept-map` draws a Grok Imagine space-themed mission brag sheet from note markdown + lock-in stats (6/hour per user). See `specs.md`.
