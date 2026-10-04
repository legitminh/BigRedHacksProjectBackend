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
  "cache_ttl_seconds": 30,
  "services": [
    {
      "id": "gemini",
      "label": "Gemini coach",
      "state": "ok",
      "status": "Connected",
      "detail": "Cloud coach ready (gemini-flash-latest)",
      "optional": false
    }
  ]
}
```

- `state`: `ok` | `warn` | `err` (dot color)
- `status`: short badge (`Connected`, `Offline`, `Quota`, `Degraded`)
- Gemini + Ollama probes are cached in-process for `cache_ttl_seconds` (30s)
- `ok` is false when a critical row is `err` (`api`, `google_oauth`, `ollama`, `chat_provider`)

## Indicators

| `id` | Meaning |
|---|---|
| `gemini` | Live list-models probe against Google Generative Language using `GEMINI_API_KEY`. `Quota` on 429 / resource-exhausted. |
| `google` | Optional. `calendar_connected` and `drive_connected` are independent tool links; `google_connected` is true only when both are. Not a combined required link. Without a JWT: sign-in prompt. |
| `ollama` | `GET {OLLAMA_BASE_URL}/api/tags` on the API host. Checks lock-in model (`OLLAMA_MODEL`) and chat model (`OLLAMA_CHAT_MODEL`). |
| `chat_provider` | Which engine serves Copilot chat right now (from `LOCAL_CHAT_PROVIDER` + probe health). Health only — does not switch providers. |
| `account` | Signed-in Waypoint user when `Authorization` is valid; otherwise “Sign in…”. |
| `google_oauth` | Server has `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` (login flow can start). |
| `api` | This process answered; includes storage backend (`file` / `postgres`). |

## Not on this page

| Item | Why |
|---|---|
| macOS permissions (screen, camera, mic, accessibility) | Device-local; Settings → Permissions via Tauri. |
| Presage API key | Local `secrets.toml` only — not a server service. |
| xAI / companion internals | Owned by other agents; not probed here. |

## Desktop wiring

Tauri command `service_status` → `GET /v1/status` (authed when a JWT is stored). `src/main.ts` `renderConnectionStatus` maps each service to a row; no client-side health logic.
