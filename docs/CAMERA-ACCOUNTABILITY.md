# Camera accountability (server-side)

Inspired by [VIDEOINPUT](https://github.com/dhanvi2612/VIDEOINPUT): camera → Presage scalars + presence state on the **API**; desktop only captures short clips and uploads them. Sparse nudges; never recite HR/RR numbers; no nagging during pause/break; short calm lines that point back to the work.

## Contract

### `POST /v1/camera/observe` (auth: user JWT)

Request JSON:

```json
{
  "session_id": "lock-in session id from desktop",
  "phase": "active" | "paused" | "break",
  "mime": "video/mp4" | "video/webm" | "image/jpeg",
  "data_base64": "<base64 payload, max ~8MB decoded>",
  "client_meta": { "brightness": 0 }
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
  "nudge": { "kind": "left_desk", "text": "Looks like you stepped away. Come back when you can." },
  "watching_note": "Camera accountability · present"
}
```

Nudge `kind` values (internal tags — **never** speak the kind string; use `text`):

| kind | Meaning | Spoken intent |
|------|---------|---------------|
| `left_desk` | Confirmed out of frame (absence ladder, **active** only) | Stepped away — come back |
| `left_desk_pause` | Still away ~2 min — end away-nags for this leave (**not** mission pause) | Pause check-ins until back |
| `welcome_back` | Confirmed return after leave (**active** only) | Welcome back |
| `camera_obstructed` | Lens/lighting unclear held ~30s (**active** only) | Fix camera/lighting |
| `suggest_break` | Stress → voluntary five-minute break invite (primary) | Optional break card |
| `stressed` | Stress breath fallback after a recent `suggest_break` | Slow breath |

- `nudge` is `null` when silent (cooldown, `paused`/`break`, already spoken ladder step, etc.).
- Rate limit: ~1 observe / 25s per user (429 if faster).
- Do not persist video bytes. Process then discard.
- If `PRESAGE_API_KEY` unset or Presage fails: still run presence heuristics; **`vitals` is `null`** (no invented stress). Desktop may apply local VIDEOINPUT fallback separately.
- `vitals.stressed` from Presage when `stress_index > 150` **or** HRV/RMSSD `< 20`.

### Env

`PRESAGE_API_KEY` — server only (never in the Mac app for this path).

## Spirit (nudge policy)

- Under ~12 words for lock-in nudges; max ~25 for check-ins.
- Absence ladder (active phase only): first callback → second → pause acknowledgment; then stay quiet.
  - Confirm leave after sustained away (2 observes / brief hold) so glances do not chatter.
  - Ladder clock starts at the first away candidate; with ~25–30s observe cadence a real away (~20–60s+) gets the first `left_desk` on the confirming observe.
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
- Capture short clip → `POST /v1/camera/observe` → apply `nudge` via existing coach overlay/TTS; update vitals UI from response.
- When `nudge.kind === "suggest_break"` → call local Tauri `suggest_break_timer` (**emit only**; Accept/Not now on desktop — do not auto-start).
- Pass `phase: "break"` while the local break timer is running (and `"paused"` for mission pause) so the API stays silent.
- Do **not** call Presage from the desktop when using this path.
