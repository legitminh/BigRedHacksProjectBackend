# Camera accountability (server-side)

Inspired by [VIDEOINPUT](https://github.com/dhanvi2612/VIDEOINPUT): camera → presence + optional **Presage** scalars on the **API**. Desktop owns the **live-feed** (continuous local Vision / yaw / brightness); sparse clip observes still upload short media and merge `client_meta` attention. Sparse nudges; never recite HR/RR numbers; no nagging during pause/break; short calm lines that point back to the work.

**Do not** run a local LLM / VLM on webcam frames for `left_desk` / phone / stress. Presage owns optional vitals when local face is omitted. Local OCR/VLM stay on **screen** signals only.

## Contract

### `POST /v1/camera/observe` (auth: user JWT)

Request JSON:

```json
{
  "session_id": "lock-in session id from desktop",
  "phase": "active" | "paused" | "break",
  "mime": "video/mp4" | "video/webm" | "image/jpeg",
  "data_base64": "<base64 payload, max ~8MB decoded>",
  "client_meta": {
    "brightness": 128,
    "brightness_measured": true,
    "face_detected": true,
    "attention": "present" | "absent" | "looking_down" | "looking_away",
    "last_nudge_ack": "left_desk"
  }
}
```

Response 200:

```json
{
  "ok": true,
  "presence": "present" | "left_frame" | "uncertain" | "camera_obstructed",
  "face_detected": true,
  "vitals": {
    "heart_rate": null,
    "breathing_rate": null,
    "stress_index": null,
    "stressed": false,
    "focus_ok": true,
    "source": "presage"
  },
  "nudge": { "kind": "left_desk", "text": "You've stepped away. Come back to the work when you can." },
  "watching_note": "Camera accountability · present"
}
```

Nudge `kind` values (internal tags — **never** speak the kind string; use `text`):

| kind | Meaning | Spoken intent |
|------|---------|---------------|
| `left_desk` | Confirmed leave (D1 absence ladder, **active** only) — **not** a phone accusation | Stepped away — come back |
| `look_back` | In-frame gaze away (`looking_away` / confirmed `looking_down`) — **never** `left_desk` | Turn eyes back to work |
| `suggest_break` | Stress **or** ~3 min still away (D1 mid-ladder) → voluntary break invite | Optional break card |
| `left_desk_pause` | Still no face ~10 min — end away-nags (**not** mission pause) | Stay quiet until back |
| `welcome_back` | Confirmed return after leave ≥20s (**active** only) | Welcome back |
| `camera_obstructed` | Lens/lighting unclear held ~8s (**active** only) | Fix camera/lighting |
| `stressed` | Stress breath fallback after a recent `suggest_break` | Slow breath |

- `nudge` is `null` when silent (cooldown, `paused`/`break`, already spoken ladder step, etc.).
- Rate limit: ~1 observe / 25s per user (429 if faster). Concurrent observes for the same session are serialized server-side.
- **Live-feed primary:** continuous presence/attention belongs on the desktop. Prefer FE-local timers (Dhanvi `glance_ignore_s=8`, `look_up_or_away_s=30`) and post majority attention on clip observes. A meta-only observe path is not worth it — frequent ticks would hit the rate limit; keep BE as clip + attention merge.
- Do not persist video bytes on the API host. Process then discard locally. **When `PRESAGE_API_KEY` is set, phase is `active`, and the client did not post local `face_detected`, short video clips are uploaded to Presage Physiology (third-party biometric processing).** Retention at Presage is outside Waypoint control — unset the key to disable uploads; pause/break phases never upload. Prefer shortest clips; rotate the key after vendor incidents.
- If `PRESAGE_API_KEY` unset, Presage transport/auth fails, phase is `paused`/`break`, or mime is `image/jpeg`: still run presence heuristics; when local `face_detected` is posted it remains PRIMARY. Without local face, **`face_detected: null`** (uncertain — do **not** mark away); **`vitals` is `null`** (no invented stress). JPEG observes cannot detect leave/stress via Presage — desktop should send `video/mp4` or `video/webm` when vitals are needed.
- Empty Presage success (no usable scalars, no explicit face flag) stays **uncertain** — not away. Real leave requires local `face_detected: false` or an explicit vendor face/quality signal.
- `vitals.stressed` from Presage when `stress_index > 150` **or** HRV/RMSSD `< 20` (zero/sentinel HRV ignored).
- Camera ladder / stress cooldown state is **in-process only** (single API instance; restart may re-nag).

### Timings (`PRESENCE_TIMINGS` in `src/camera/presence.ts`)

| Key | Value | Role |
|-----|-------|------|
| `glanceIgnoreS` | 8 | Dhanvi FE: ignore brief glances |
| `lookUpOrAwayS` | 30 | Dhanvi FE: hold before `looking_away` is meaningful |
| `lookAwayConfirmObserves` / `Ms` | 1 / 3s | BE: confirm `looking_away` fast once posted |
| `lookDownConfirmObserves` / `Ms` | 2 / 5s | BE: slightly more cautious for head-down |
| `leftFrameFirstCallbackMs` | 25s (demo 10s) | First `left_desk` rung |
| `cameraObstructedMs` | 8s | Snappy obstructed speak (Waypoint UX) |
| `lookBackCooldownMs` | 45s | Sparse re-nag for gaze-away |

### Env

`PRESAGE_API_KEY` — server only (never in the Mac app for this path). Unset disables third-party video upload.

## Spirit (nudge policy)

- Under ~12 words for lock-in nudges; max ~25 for check-ins.
- Absence ladder (active phase only; case-catalog D1 spirit): silent under ~25s → `left_desk` callback → ~3 min `suggest_break` invite → ~10 min `left_desk_pause` quiet.
  - Confirm leave after sustained away (2 observes / brief hold) so glances do not chatter.
  - Ladder clock starts at the first away candidate; with ~25–30s observe cadence a real away gets the first `left_desk` on the confirming observe.
  - Do **not** accuse phone on face-lost (phone is C1 with a detector we do not run); head-down without a box is not a phone nudge.
- Gaze-away (`looking_away` / `looking_down`): face still in frame → `look_back` only; **never** promote to `left_desk`.
  - `looking_away` (Dhanvi head_turned): “You're looking away. Turn back to the work.” — confirm on first observe.
  - `looking_down`: phone-lap hedge line; needs 2 observes / short hold.
- Welcome-back once after confirmed return; no praise after a nudge in the same beat.
- Stress family (`suggest_break` ↔ `stressed`):
  - Shared **180s** cooldown (`STRESS_COOLDOWN_MS`).
  - Prefer `suggest_break` (“optional five-minute break”) — **suggestion only; server never starts a break**.
  - Alternate with `stressed` (slow breath) so break offers stay sparse.
  - Silent on `phase: "break"` / `"paused"`. Quiet-phase observes also refresh the stress cooldown clock so resume after a break does not immediately re-nudge.
  - Never speak biometric numbers; spell out “five” (no digits in stress copy).
- Glances / brief uncertainty: ignore (no chatter).

## Desktop

- Optional toggle (existing camera signals prefs) = accountability camera on for lock-in.
- **Primary path:** local live camera → continuous presence/attention → short clip + `client_meta` → `POST /v1/camera/observe` → apply `nudge` via existing coach overlay/TTS; update vitals UI from response.
- When `nudge.kind === "suggest_break"` → call local Tauri `suggest_break_timer` (**emit only**; Accept/Not now on desktop — do not auto-start).
- Pass `phase: "break"` while the local break timer is running (and `"paused"` for mission pause) so the API stays silent.
- Do **not** call Presage from the desktop when using this path.
