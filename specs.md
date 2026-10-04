# Waypoint API — memory, calendar, tasks

Account login is already specified in `devplan.md` and `README.md`. This file is the next product surface: a durable student profile, Google Calendar deadlines and confirmed event writes, and the task record the desktop app uses for advise vs pair.

The app sends `Authorization: Bearer <access_token>` on every route below. The client never writes Postgres. Gemini Live is proxied by this server (`WS /v1/companion/live`); the legacy client-side ephemeral token (`POST /v1/session/ephemeral-token`) is off unless `ENABLE_EPHEMERAL_TOKEN=1`. These routes are the tools' side effects.

Errors keep the existing shape:

```json
{ "error": { "code": "unauthorized", "message": "Sign in required." } }
```

## Memory

One row per user. `GET /v1/memory` returns the profile card injected into Gemini, not the raw sample list.

```json
{
  "interests": ["distributed systems"],
  "proficiencies": [{ "topic": "heaps", "level": "learning" }],
  "long_term_goals": ["Pass CS 4820"],
  "priorities": ["CS 4820 HW3", "CS 4410 prelim"],
  "pace": [{ "topic": "heaps", "median_minutes": 40, "samples": 3 }],
  "interaction": {
    "tone": "brief",
    "default_mode": "advise",
    "interrupt": "sustained_only",
    "voice": true,
    "check_in_minutes": 10
  },
  "updated_at": "2026-10-03T17:00:00Z"
}
```

`tone` is `brief` or `explanatory`. `default_mode` is `advise`, `pair`, or `ask`. `interrupt` is `never`, `sustained_only`, or `immediate`.

Empty profile is valid: arrays empty, interaction at the defaults above (`advise`, `brief`, `sustained_only`, voice on, 10 minutes).

### `PUT /v1/memory`

Replaces explicit fields. Omitted fields stay as they are. Used by the profile screen and by a confirmed `remember` tool.

```json
{
  "interests": ["distributed systems", "climbing"],
  "proficiencies": [{ "topic": "heaps", "level": "learning" }],
  "long_term_goals": ["Pass CS 4820"],
  "priorities": ["CS 4820 HW3"],
  "interaction": { "tone": "brief", "default_mode": "pair" }
}
```

Caps: 12 interests, 20 proficiencies, 8 goals, 8 priorities. `400` `memory_too_large` past a cap. Topics are matched case-insensitively; the stored spelling is the newest one.

### `POST /v1/memory/pace`

Append one sample. Called at the end of a problem, including abandoned attempts.

```json
{
  "topic": "heaps",
  "problem": "HW3 problem 3",
  "planned_minutes": 30,
  "actual_minutes": 30,
  "outcome": "finished",
  "task_id": "<optional uuid>"
}
```

`outcome` is `finished`, `partial`, or `abandoned`. The median on the card uses the last 8 `finished` samples for that topic. `planned_minutes` and `actual_minutes` are integers from 1 to 240.

### `POST /v1/memory/proficiency`

Move a topic one step (`learning` → `comfortable` → `strong`, or the reverse). A direct `PUT` may jump levels; this route may not. `409` `proficiency_step` if the requested level is more than one step away.

### Tables

- `user_profiles`: `user_id` PK references `users`, `interests` text[], `long_term_goals` jsonb, `priorities` jsonb, `interaction` jsonb, `updated_at`
- `proficiencies`: PK `(user_id, topic)`, `level`, `updated_at`
- `pace_samples`: `id`, `user_id`, `topic`, `problem`, `planned_minutes`, `actual_minutes`, `outcome`, `task_id` nullable, `recorded_at`

`GET /v1/memory/pace?topic=heaps` returns the samples (newest first, default 8) for the profile screen. The model does not need this route; it sees the median on the card.

## Calendar

Desktop sign-in (`POST /v1/auth/google/start`) already requests the bundled scopes `openid email profile`, `calendar.events`, and `drive.readonly` in one consent. `POST /v1/google/calendar/start` is a second consent (re-connect / incremental) with `include_granted_scopes=true`, scopes `calendar.events drive.readonly`, `access_type=offline`. The new refresh token replaces `users.google_refresh_token`. Disconnecting Calendar nulls that use of the token's calendar scope by storing a flag `calendar_connected` (default false) rather than deleting the identity session.

`calendar_connected` is false until a grant exists (bundled sign-in or this flow). Memory and tasks work either way.

Limitation: pending calendar-connect state (state, PKCE verifier, poll token) is **in-memory only** with a short TTL. An API restart drops in-flight connects; the app calls `/v1/google/calendar/start` again. Completed grants are durable.

### `POST /v1/google/calendar/start`

Same response shape as `POST /v1/auth/google/start`: `authorization_url`, `state`, `poll_token`, `expires_in`. Requires a Waypoint bearer token so the grant attaches to the signed-in user.

### `GET /v1/google/calendar/poll?poll_token=`

Same pending / complete / error contract as login poll. `complete` returns `{ "status": "complete", "calendar_connected": true }` and does not issue a new Waypoint token.

### `GET /v1/calendar/agenda?days=14`

Server-side classification of primary-calendar events from now through `days` (1–30, default 14).

```json
{
  "deadlines": [
    {
      "id": "google-event-id",
      "title": "CS 4820 HW3 due",
      "due": "2026-10-06",
      "all_day": true,
      "waypoint": false
    }
  ],
  "blocks": [
    {
      "id": "google-event-id",
      "title": "Study: priority queues",
      "start": "2026-10-03T19:00:00-04:00",
      "end": "2026-10-03T19:40:00-04:00",
      "waypoint": true
    }
  ]
}
```

An event is a deadline when it is all-day or its title matches `(?i)\b(due|deadline|submit|exam|quiz|prelim|midterm|final|hw|pset|assignment)\b`. Everything else in the window is a block. `waypoint` is true when the event's private extended property `waypoint` is `1`.

`409` `calendar_not_connected` if the user has not finished the calendar consent.

### `POST /v1/calendar/events`

Creates one event on the primary calendar. The desktop app calls this only after the student confirms the proposal card.

```json
{
  "title": "Study: priority queues",
  "kind": "study_block",
  "start": "2026-10-03T19:00:00-04:00",
  "end": "2026-10-03T19:40:00-04:00"
}
```

`kind` is `study_block` or `deadline`. A deadline is stored all-day on the `start` date; `end` is ignored. A study block requires `start` and `end`, with a duration from 10 to 240 minutes. Title is required, max 120 characters.

The created event gets private extended properties `waypoint=1` and `waypointKind`. Response is the agenda item shape plus `html_link`.

### `PATCH /v1/calendar/events/:id` and `DELETE /v1/calendar/events/:id`

Allowed only when `waypoint=1`. Otherwise `403` `not_waypoint_event`. Patch accepts a new `start` / `end` for a study block, or a new `due` date for a deadline. Students' class events and Canvas deadlines are never modified.

## Tasks

The active task is what advise vs pair applies to. Gemini still produces the words; the API stores the mode and the clock used for the pace sample.

### `POST /v1/tasks`

```json
{
  "title": "Problem 3",
  "mode": "advise",
  "planned_minutes": 30,
  "deadline_event_id": "<optional google event id>"
}
```

Creates an `active` task. Any previous `active` task for this user becomes `dropped`.

### `GET /v1/tasks/active`

The active task, or `404` `no_active_task`.

### `PATCH /v1/tasks/:id`

`mode`, `title`, or `planned_minutes`. Mode switches do not reset `started_at`.

### `POST /v1/tasks/:id/complete`

```json
{ "outcome": "finished", "topic": "heaps" }
```

Sets `ended_at`, stores `outcome`, and appends a pace sample. `actual_minutes` is the rounded elapsed time since `started_at` minus time the client reports in `break_minutes` (default 0). Status becomes `done` for `finished` and `partial`, and `dropped` for `abandoned`.

### Table

`tasks`: `id`, `user_id`, `title`, `mode`, `status` (`active`, `done`, `dropped`), `planned_minutes`, `deadline_event_id`, `outcome`, `started_at`, `ended_at`.

## Session summary

`POST /v1/sessions` stores the lock-in recap the app speaks at the end. One row per ended lock-in.

```json
{
  "task_id": "<uuid>",
  "started_at": "2026-10-03T18:30:00Z",
  "ended_at": "2026-10-03T19:00:00Z",
  "break_minutes": 0,
  "attention": "recovered",
  "note": "Stuck on the priority queue, then finished push."
}
```

`attention` is `steady`, `recovered`, or `dropped`. This is a log, not an input to the profile card, except that task completion already wrote the pace sample.

## Session notes

`POST /v1/session-notes` stores the Markdown note the desktop writes when a lock-in ends. The API does not call Gemini and does not accept screenshots or images. One row per user and client `session_id`.

```json
{
  "session_id": "lock-in-1",
  "started_at": "2026-10-03T18:30:00Z",
  "ended_at": "2026-10-03T19:00:00Z",
  "goals": "Finish the priority queue",
  "kind": "study",
  "markdown": "## Lock-in\n\nFinished push."
}
```

`kind` is `study` or `devlog`. `goals` may be empty and is capped at 2,000 characters (`400` `goals_too_long`). `markdown` is required and capped at 32,000 characters (`400` `note_too_long`). `session_id` is a non-empty string up to 512 characters. `started_at` and `ended_at` are ISO-8601 timestamps, and `ended_at` must not be before `started_at`. Fields named like `image` or `screenshot`, and base64 image payloads, are rejected with `400` `image_not_allowed`. Other unknown fields are ignored.

The first POST returns `201` with the stored row (`id`, `user_id`, `session_id`, `started_at`, `ended_at`, `goals`, `kind`, `markdown`, `created_at`). A second POST with the same `session_id` for this user replaces `markdown`, `kind`, `goals`, `started_at`, and `ended_at`, keeps the same `id` and `created_at`, and returns `200`.

`GET /v1/session-notes` returns `{ "notes": [...] }` for the signed-in user, newest `ended_at` first, at most 50, including full markdown.

`GET /v1/session-notes/:id` returns one note, or `404` when it is missing or belongs to someone else.

`GET /v1/memory` includes `recent_notes`: up to five `{ id, session_id, ended_at, kind, goals, excerpt }`. `excerpt` is the first 240 characters of markdown with whitespace runs collapsed to single spaces. `study_memory` is unchanged.

### Table

`session_notes`: `id`, `user_id`, `session_id`, `started_at`, `ended_at`, `goals`, `kind`, `markdown`, `created_at`. Unique on `(user_id, session_id)`. Indexed on `(user_id, ended_at DESC)`.

## What stays on the client

- Gemini tool loop and the advise vs pair reply policy
- Confirmation UI for `remember` and `proposeEvent`
- Screenshot capture, voice, and the 15-second on-task check
- Grok Voice playback

The API does not call Gemini and does not see screenshots.
