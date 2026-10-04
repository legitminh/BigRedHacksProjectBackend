# Waypoint API development plan

Branch: `authentication`. This repository only. The Tauri app stays untouched.

## What the backend is for

Waypoint’s desktop app currently signs in with a local placeholder (`src-tauri/src/auth.rs` accepts any username and ignores the password) and runs Google OAuth on the device (`src-tauri/src/google/oauth.rs` holds the client secret and stores Calendar/Drive tokens in the app data directory).

`specs.md` moves account control to this server so Waypoint can monetize logins, hand the app short-lived credentials, and keep user metadata plus session history on TigerData (Postgres).

This branch ships the first slice: **Google account login**. Later slices are listed at the bottom and are not implemented here.

## This slice

A TypeScript HTTP server the desktop app can call.

1. The app asks the server for a Google authorization URL.
2. The user signs in with Google in the system browser. The redirect lands on this server, not on a localhost port inside the app.
3. The server exchanges the code, reads the Google profile, and upserts a Waypoint user.
4. The app polls until the server returns a Waypoint access token and refresh token.
5. Later calls send `Authorization: Bearer <access_token>`.

The Google client secret never ships in the desktop binary. Google refresh tokens, if Google returns one, stay on the server and are not sent to the client.

Sign-in uses one bundled consent: identity (`openid`, `email`, `profile`) plus `calendar.events` and `drive.readonly`. The server stores the Google refresh token and brokers Calendar/Drive; the app never holds Google data tokens.

## Stack

- Node.js 22+ and TypeScript, run with `node --experimental-strip-types` (no compile step).
- `node:http` for the server. No web framework.
- `fetch` for Google’s token and userinfo endpoints.
- HMAC-SHA256 JWTs via `node:crypto` for access tokens.
- TigerData through `pg` when `DATABASE_URL` is set.
- A gitignored JSON file (`data/store.json`) when `DATABASE_URL` is empty, so the process can boot from `.env.example` alone.

There is no `.env` with real keys in this repo. Ship `.env.example` only. The server starts without Google or database credentials and returns a clear error on the OAuth routes until those values are filled in.

## HTTP API

Default base URL: `http://127.0.0.1:8787`.

Errors:

```json
{ "error": { "code": "invalid_state", "message": "Sign-in state was not recognized." } }
```

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/health` | no | Process up, and whether storage is `file` or `postgres` |
| POST | `/v1/auth/google/start` | no | Begin Google login |
| GET | `/v1/auth/google/callback` | no | Google redirect target |
| GET | `/v1/auth/google/poll` | no | Desktop app waits for the browser login to finish |
| POST | `/v1/auth/refresh` | no | Rotate a refresh token into a new access token |
| POST | `/v1/auth/sign-out` | Bearer | Revoke refresh tokens for this user |
| GET | `/v1/me` | Bearer | Current Waypoint user |

### `POST /v1/auth/google/start`

No body. Creates a 10-minute pending login.

`200`:

```json
{
  "authorization_url": "https://accounts.google.com/o/oauth2/v2/auth?...",
  "state": "<csrf>",
  "poll_token": "<secret>",
  "expires_in": 600
}
```

`503` `google_not_configured` when client id, client secret, or redirect URI is missing. `503` `session_secret_missing` when `SESSION_SECRET` is missing or shorter than 32 characters. Tokens are not issued with a generated secret, because a restart would silently invalidate them.

The authorization URL includes:

- `response_type=code`
- `code_challenge` / `code_challenge_method=S256` (PKCE; the verifier stays on the server)
- `state`
- `scope=openid email profile https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/drive.readonly`
- `access_type=offline` and `prompt=consent` so Google can return a refresh token for a later Calendar/Drive slice
- `redirect_uri` equal to `{PUBLIC_BASE_URL}/v1/auth/google/callback`

### `GET /v1/auth/google/callback`

Query: `code`, `state`, or `error` from Google. Browser only. Responds with HTML, not JSON.

On success the server exchanges the code, loads `https://www.googleapis.com/oauth2/v3/userinfo`, upserts the user by `google_sub`, stores a hashed Waypoint refresh token, and marks the matching poll as `complete`. The HTML page tells the user to return to Waypoint.

On failure the poll is marked `error` and the page says sign-in failed.

### `GET /v1/auth/google/poll?poll_token=`

`200` while the browser flow is unfinished:

```json
{ "status": "pending", "expires_in": 540 }
```

`200` once, after success:

```json
{
  "status": "complete",
  "token_type": "Bearer",
  "access_token": "<jwt>",
  "refresh_token": "<opaque>",
  "expires_in": 900,
  "user": {
    "id": "<uuid>",
    "email": "student@cornell.edu",
    "email_verified": true,
    "name": "Student",
    "picture": "https://..."
  }
}
```

The poll token is deleted after a `complete` or `error` read so it cannot be replayed. A second read is `404` `poll_not_found`. An unused token past its deadline is `410` `poll_expired`.

### `POST /v1/auth/refresh`

```json
{ "refresh_token": "<opaque>" }
```

`200` returns a new access token, a new refresh token, and `expires_in`. The presented refresh token is revoked (rotation). Reuse of an already-rotated token revokes every refresh token for that user and returns `401` `refresh_reuse`.

### `POST /v1/auth/sign-out`

`Authorization: Bearer <access_token>`.

```json
{ "refresh_token": "<optional>", "all": false }
```

Revokes the given refresh token, or every refresh token for the user when `all` is true. `204` empty body.

### `GET /v1/me`

`Authorization: Bearer <access_token>`. `200` is the `user` object above. `401` `unauthorized` when the token is missing, expired, or malformed.

### Access token

JWT, header `{"alg":"HS256","typ":"JWT"}`, signed with `SESSION_SECRET`.

Claims: `sub` (user id), `email`, `typ: "access"`, `iat`, `exp`. Lifetime `ACCESS_TOKEN_TTL_SECONDS` (default 900).

Refresh tokens are 32 random bytes, base64url. Only their SHA-256 hashes are stored. Lifetime `REFRESH_TOKEN_TTL_SECONDS` (default 30 days).

## Data

Pending logins (state, PKCE verifier, poll token, status) live in process memory with a 10-minute TTL. One API process is assumed. Calendar-connect pending state (`CalendarConnects`) is likewise memory-only. A restart drops in-flight browser logins and calendar connects; the app starts again.

Users and refresh tokens are durable.

Postgres / TigerData (`src/db/schema.sql`), applied on startup when `DATABASE_URL` is set:

- `users`: `id`, `google_sub` unique, `email`, `email_verified`, `name`, `picture`, `google_refresh_token`, `created_at`, `last_login_at`
- `refresh_tokens`: `id`, `user_id`, `token_hash` unique, `expires_at`, `revoked_at`, `replaced_by`, `created_at`

`google_refresh_token` is nullable and never selected into API responses.

Without `DATABASE_URL`, the same records go to `data/store.json`.

## Request handling

- JSON bodies only on POST. Limit 16 KiB.
- CORS: reflect `Origin` when it is `tauri://localhost`, `http://tauri.localhost`, `http://localhost:*`, or `http://127.0.0.1:*`, plus any origin in `WAYPOINT_CORS_ORIGINS`. The Tauri app should still call this API from Rust (`reqwest`), where CORS does not apply. CORS is there if the webview calls the API directly.
- Do not log authorization codes, tokens, or the session secret.

## Environment

`.env.example`:

```
PORT=8787
PUBLIC_BASE_URL=http://127.0.0.1:8787
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
SESSION_SECRET=
DATABASE_URL=
ACCESS_TOKEN_TTL_SECONDS=900
REFRESH_TOKEN_TTL_SECONDS=2592000
WAYPOINT_CORS_ORIGINS=
```

`GOOGLE_REDIRECT_URI` is not a separate variable. It is always `{PUBLIC_BASE_URL}/v1/auth/google/callback`. The Google Cloud client must be a **Web application** client, and that exact redirect URI must be listed. That is a different credential from the desktop client the app uses today for Calendar and Drive.

## Layout

```
src/index.ts              listen, load .env
src/config.ts             env parsing
src/server.ts             router
src/http.ts               json, errors, cors
src/auth/google.ts        URL, code exchange, userinfo
src/auth/tokens.ts        JWT and refresh tokens
src/auth/pending.ts       in-memory login transactions
src/store/types.ts
src/store/file.ts
src/store/postgres.ts
src/store/index.ts
src/db/schema.sql
test/auth.test.ts         mocked Google HTTP
.env.example
.gitignore
package.json
README.md                 frontend integration
```

## Tests

`npm test` with `node:test`. Google’s token and userinfo URLs are injected so tests never call Google.

- Start refuses to run without Google credentials and without a long enough session secret.
- Start URL contains PKCE, state, and the bundled identity + Calendar + Drive scopes.
- Callback with a bad state returns an error page and does not complete the poll.
- A mocked code exchange plus userinfo completes the poll once and creates the user.
- A second poll of the same token is not found.
- Refresh rotation issues a new pair and rejects the old refresh token.
- Replaying a rotated refresh token revokes the user’s sessions.
- `/v1/me` requires a valid access token.
- Sign-out revokes refresh tokens.

## How the frontend should call it

Documented in `README.md` with curl and a Rust sketch. The app changes are not part of this branch.

1. `POST /v1/auth/google/start`
2. Open `authorization_url` with the system browser.
3. Poll `GET /v1/auth/google/poll` about twice a second until `complete`, `error`, or timeout (the pending login lasts 10 minutes).
4. Persist `access_token`, `refresh_token`, and `user` in the Waypoint data directory. Replace the placeholder `waypoint_session.json` flow when the app is wired up.
5. Send the access token on `GET /v1/me` and later authenticated routes.
6. On `401`, `POST /v1/auth/refresh` once and retry.
7. `POST /v1/auth/sign-out` with `all: true`, then delete the saved tokens.

## Later slices

Product contract: `specs.md`. These are on `main`:

1. Email code login and SMTP, with the same Waypoint token format as Google.
2. Server-side Live proxy (`WS /v1/companion/live`) so the app does not embed `GEMINI_API_KEY`.
3. Memory profile: `GET` / `PUT /v1/memory`, pace samples, and one-step proficiency.
4. Tasks (`advise`, `pair`, `ask`) and `POST /v1/sessions` for the lock-in recap.
5. Incremental Calendar consent, agenda classification, and create/update/delete only for events Waypoint created.
