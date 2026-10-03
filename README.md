# Waypoint API

Account server for the Waypoint desktop app. This slice is Google sign-in. The Google client secret stays here. The app receives a Waypoint access token and refresh token, then sends the access token on later requests.

Calendar and Drive access still use the desktop OAuth client inside the Tauri app. This server does not replace that yet.

## Run

```bash
cd BigRedHacksProjectBackend
npm install
cp .env.example .env
```

There is no `.env` with real keys in the repo. Fill `.env` before trying a real Google login:

```bash
openssl rand -base64 32
```

Put that value in `SESSION_SECRET` (at least 32 characters). Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from the Web client below. Leave `DATABASE_URL` empty to store users in `data/store.json`. Set it to a TigerData Postgres URL when you want users stored there. The server creates the tables in `src/db/schema.sql` on startup.

```bash
npm run dev
```

The process listens on `http://127.0.0.1:8787`. `GET /health` returns:

```json
{ "ok": true, "service": "waypoint-api", "storage": "file" }
```

`storage` is `postgres` when `DATABASE_URL` is set. `npm test` covers the login flow and study-session summaries with Google mocked.

## Google Cloud client

Create a **Web application** OAuth client. The desktop client already baked into Waypoint is a different credential and will not work as this redirect target.

1. Open [Google Cloud Console](https://console.cloud.google.com/) and select the Waypoint project.
2. **APIs & Services → OAuth consent screen**. App name `Waypoint`. Add the Google accounts that will sign in while the app is in testing.
3. Scopes for this server: `openid`, `email`, `profile`.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
5. Application type: **Web application**. Name: `Waypoint API`.
6. Authorized redirect URI:

```text
http://127.0.0.1:8787/v1/auth/google/callback
```

That URI is `{PUBLIC_BASE_URL}/v1/auth/google/callback`. If you change `PUBLIC_BASE_URL`, add the new URI on the same client and restart the server.

7. Copy the client id and client secret into `.env`.

## Calling the API from Waypoint

Base URL: `http://127.0.0.1:8787`, or whatever host you deploy this process on. Call it from Rust (`reqwest` is already in the app), the same way `connect_google` opens the system browser today. The webview may also call it: `http://localhost`, `http://127.0.0.1`, and `tauri://localhost` are allowed CORS origins.

Replace the placeholder `sign_in_waypoint` / `sign_out_waypoint` commands. Leave `connect_google` in place until Calendar and Drive move to the server.

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

### 6. Study sessions

After lock-in starts, create a session. During the session, append events for focus samples, breaks, speech, and distractions. This server stores the log and computes the official summary. The client displays that summary; it does not calculate time spent, break time, or attention itself.

Every session route needs `Authorization: Bearer ACCESS_TOKEN`. You only see your own sessions. An unknown id, including another user's session, is `404` `session_not_found`.

Events are kept in `data/store.json` when `DATABASE_URL` is empty. When it is set, they are rows in Postgres (`study_sessions` and `session_events`). Each event's `at` is a `timestamptz`, so the table is an append-only history.

Start the session:

```bash
curl -s -X POST http://127.0.0.1:8787/v1/sessions \
  -H "Authorization: Bearer ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"goals":"Finish the problem set","duration_secs":1500,"modality":"pomodoro"}'
```

`201`:

```json
{
  "id": "3f1c0b2a-7e4d-4c9a-8b11-2d6e5f708192",
  "goals": "Finish the problem set",
  "duration_secs": 1500,
  "modality": "pomodoro",
  "started_at": "2026-10-03T18:30:00.000Z"
}
```

`400` `invalid_session` means `goals` is empty or `duration_secs` is missing or not a positive number.

While the session is running, `POST /v1/sessions/SESSION_ID/events`. `type` is one of `focus_sample`, `break_started`, `break_ended`, `coach_spoke`, `user_spoke`, `distraction`, or `session_ended`. `at` is an optional ISO timestamp and defaults to the server clock. `payload` is an optional object. A `focus_sample` must include `payload.focus` as a number from 0 to 1.

```bash
curl -s -X POST http://127.0.0.1:8787/v1/sessions/SESSION_ID/events \
  -H "Authorization: Bearer ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"focus_sample","payload":{"focus":0.8}}'
```

```bash
curl -s -X POST http://127.0.0.1:8787/v1/sessions/SESSION_ID/events \
  -H "Authorization: Bearer ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"break_started"}'
```

```bash
curl -s -X POST http://127.0.0.1:8787/v1/sessions/SESSION_ID/events \
  -H "Authorization: Bearer ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"break_ended"}'
```

```bash
curl -s -X POST http://127.0.0.1:8787/v1/sessions/SESSION_ID/events \
  -H "Authorization: Bearer ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"distraction","payload":{"source":"phone"}}'
```

```bash
curl -s -X POST http://127.0.0.1:8787/v1/sessions/SESSION_ID/events \
  -H "Authorization: Bearer ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"session_ended"}'
```

`201` is `{ "id", "type", "at" }`. `400` `invalid_event` means the type is unknown, `focus` is outside 0 to 1, or `at` is not a timestamp.

`GET /v1/sessions/SESSION_ID` returns the session plus `events`, oldest first.

At the end, after `session_ended`, read the summary and show time spent, break time, and attention:

```bash
curl -s http://127.0.0.1:8787/v1/sessions/SESSION_ID/summary \
  -H "Authorization: Bearer ACCESS_TOKEN"
```

```json
{
  "session_id": "3f1c0b2a-7e4d-4c9a-8b11-2d6e5f708192",
  "goals": "Finish the problem set",
  "time_spent_secs": 540,
  "break_secs": 60,
  "attention_level": 0.6,
  "event_count": 5
}
```

`break_secs` sums each `break_started` with the next `break_ended`. A break that is still open runs until `session_ended`, or until now if the session has not ended. `time_spent_secs` is the seconds from `started_at` to that same end, minus `break_secs`. `attention_level` is the average of `focus_sample` values, or `null` when there are no samples.

`GET /v1/sessions` lists this user's summaries, newest first, each with `id` and `started_at` as well:

```bash
curl -s http://127.0.0.1:8787/v1/sessions \
  -H "Authorization: Bearer ACCESS_TOKEN"
```

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

## What this server does not do yet

Email login, mail delivery, Gemini ephemeral tokens, and preference and history APIs are later slices. See `devplan.md`.
