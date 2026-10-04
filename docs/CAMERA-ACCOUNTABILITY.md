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
  "nudge": { "kind": "left_desk", "text": "You've stepped away. Come back to the work." },
  "watching_note": "Camera accountability · present"
}
```

- `nudge` is `null` when silent (cooldown, break, already spoken ladder step, etc.).
- Rate limit: ~1 observe / 25s per user (429 if faster).
- Do not persist video bytes. Process then discard.
- If `PRESAGE_API_KEY` unset: still run presence heuristics from JPEG/first-frame when possible; vitals may be null.

### Env

`PRESAGE_API_KEY` — server only (never in the Mac app for this path).

## Spirit (nudge policy)

- Under ~12 words for lock-in nudges; max ~25 for check-ins.
- Absence ladder (active phase only): first callback → second → pause acknowledgment; then stay quiet.
- Welcome-back once after confirmed return; no praise after a nudge in the same beat.
- Stress: at most one calm line every few minutes; never speak biometric numbers.
- Glances / brief uncertainty: ignore (no chatter).

## Desktop

- Optional toggle (existing camera signals prefs) = accountability camera on for lock-in.
- Capture short clip → `POST /v1/camera/observe` → apply `nudge` via existing coach overlay/TTS; update vitals UI from response.
- Do **not** call Presage from the desktop when using this path.
