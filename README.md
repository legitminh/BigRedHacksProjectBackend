# Waypoint API

Account server for the Waypoint desktop app. People sign in with Google or a one-time email code. The Google client secret stays here. The app receives a Waypoint access token and refresh token, then sends the access token on later requests.

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

Put that value in `SESSION_SECRET` (at least 32 characters). Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from the Web client below. Leave `DATABASE_URL` empty to store users in `data/store.json`. Set it to a TigerData Postgres URL when you want users stored there. The server creates the tables in `src/db/schema.sql` on startup. Leave the SMTP variables blank for local email login; the code is written to `data/outbox.jsonl`. Set `GEMINI_API_KEY` when the desktop app should mint Gemini Live tokens. Leave it blank and `POST /v1/session/ephemeral-token` returns `503`.

```bash
npm run dev
```

The process listens on `http://127.0.0.1:8787`. `GET /health` returns:

```json
{ "ok": true, "service": "waypoint-api", "storage": "file" }
```

`storage` is `postgres` when `DATABASE_URL` is set. `npm test` covers Google sign-in and email codes. Email tests inject a mailer, so they do not send mail.

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

### 6. Gemini Live token

The desktop app must not ship `GEMINI_API_KEY`. Sign in first (steps 1–2) so the app holds a Waypoint access token. Then ask this server for a Gemini credential and use that token for Gemini Live instead of a key baked into the app.

`POST /v1/session/ephemeral-token`

Auth required: `Authorization: Bearer ACCESS_TOKEN`. Body is optional (`{}` or empty).

```bash
curl -s -X POST http://127.0.0.1:8787/v1/session/ephemeral-token \
  -H "Authorization: Bearer ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

```json
{
  "token": "auth_tokens/...",
  "expire_time": "2026-10-03T17:02:00.000Z",
  "model": "gemini-flash-latest"
}
```

`token` is single-use and lasts about 30 minutes (`expire_time`). Pass it to the Gemini Live client where an API key would go. Live sessions that use this token need the `v1alpha` API. `model` is `GEMINI_MODEL`, or `gemini-flash-latest` when that variable is blank. Mint a new token for each Live session. Do not log it.

`401` `unauthorized` means the Waypoint bearer token is missing or invalid. Refresh it (step 4) or sign in again, then retry. `503` `gemini_not_configured` means `GEMINI_API_KEY` is blank on the server. `502` `gemini_token_failed` means Google did not issue a token. This response never includes the long-lived Gemini API key.

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

## What this server does not do yet

Memory, calendar deadlines and confirmed event writes, tasks, and session recap are specified in `specs.md`.
