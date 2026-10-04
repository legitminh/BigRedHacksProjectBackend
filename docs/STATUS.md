# Connection status indicators

Desktop **Settings → Connection** is a thin client of `GET /v1/status`. The API owns all live probes; the Mac UI only renders `services[]`.

Process liveness alone remains at `GET /health` (`ok`, `storage`). Prefer `/v1/status` for the product status panel.

## Endpoint

```http
GET /v1/status
Authorization: Bearer <access_token>   # optional — enriches account + Google rows
```

```json
{
  "ok": true,
  "checked_at": "2026-10-03T21:00:00.000Z",
  "cache_ttl_seconds": 300,
  "services": [
    {
      "id": "gemini",
      "label": "Gemini coach",
      "state": "ok",
      "status": "Connected",
      "detail": "Cloud coach ready (gemini-3.5-flash-lite)",
      "optional": false
    }
  ]
}
```

Full `services[]` ids (order may vary): `gemini`, `google`, `ollama`, `chat_provider`, `companion_live`, `xai_tts`, `account`, `google_oauth`, `api`, `storage`, `presage`.

- `state`: `ok` | `warn` | `err` (dot color)
- `status`: short badge (`Connected`, `Offline`, `Quota`, `Degraded`, `Ready`, `Unavailable`)
- Gemini + Ollama probes are cached in-process for `cache_ttl_seconds` (**300s** — protects Gemini free-tier RPM). Desktop should honor the payload value.
- `ok` is false when a critical row fails:
  - always: `api`, `google_oauth`, `chat_provider` (`err`)
  - signed-in: `google` Offline/warn (Calendar/Drive required for Copilot)
  - Ollama `err` only when local chat is forced (`LOCAL_CHAT_PROVIDER=ollama`) or both engines are down — cloud-primary + healthy Gemini keeps `ok` true if Ollama fallback is offline
  - `companion_live` / `xai_tts` / `presage` are **optional** (do not flip top-level `ok`); still show warn when Talk or vitals cannot run

## Gemini API surface → status row

| Status `id` | Gemini / provider surface |
|---|---|
| `gemini` | `models.list` probe (`GEMINI_API_KEY`) |
| `chat_provider` | Copilot **REST** `generateContent` (`GEMINI_MODEL`) ± Ollama fallback |
| `companion_live` | Talk **WebSocket** Live (`GEMINI_LIVE_MODEL`) **and** Grok (`XAI_API_KEY`) |
| `xai_tts` | Heads-up + Live speak (`POST /v1/voice/tts` / Live Grok). Optional for heads-ups; Live hard-requires it. |
| `presage` | Server `PRESAGE_API_KEY` (Physiology `/v2/*`) — not a desktop-local key |

**Free-tier RPD budget (ops):** status probes (signed-in, ~300s cache) + school-digest overview (≤1/day) + Copilot/companion REST chat + Live sockets share one `GEMINI_API_KEY`. Prefer Connection panel as the quota signal; chat also has per-user RPM shields.

## Indicators

| `id` | Meaning |
|---|---|
| `gemini` | List-models probe against Google Generative Language using `GEMINI_API_KEY`. `Quota` on 429 / resource-exhausted. |
| `google` | User Calendar/Drive link (`calendar_connected`). Without a JWT: sign-in prompt. |
| `ollama` | `GET {OLLAMA_BASE_URL}/api/tags` on the API host. Checks lock-in model (`OLLAMA_MODEL`) and chat model (`OLLAMA_CHAT_MODEL`). Optional fallback when Gemini is primary. |
| `chat_provider` | Which engine serves Copilot **REST** chat right now (from `LOCAL_CHAT_PROVIDER` + probe health). Health only — does not switch providers. |
| `companion_live` | Talk/Live readiness: needs `GEMINI_API_KEY` + `XAI_API_KEY`. Warn/Unavailable when Grok unset even if overall `ok` stays true. |
| `account` | Signed-in Waypoint user when `Authorization` is valid; otherwise “Sign in…”. |
| `google_oauth` | Server has `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` (login flow can start). |
| `api` | This process answered; includes storage backend (`file` / `postgres`). |
| `presage` | Config-only: server `PRESAGE_API_KEY` → camera vitals path ready (optional). |
| `xai_tts` | Config-only: `XAI_API_KEY` for Grok TTS. Heads-ups may fall back to macOS `say`; Live cannot. |
| `storage` | Postgres/TigerData vs local file store. |

## Not on this page

| Item | Why |
|---|---|
| macOS permissions (screen, camera, mic, accessibility) | Device-local; Settings → Permissions via Tauri. |

## Desktop wiring

Tauri command `service_status` → `GET /v1/status` (authed when a JWT is stored). `src/main.ts` `renderConnectionStatus` maps each service to a row; no client-side health logic.
