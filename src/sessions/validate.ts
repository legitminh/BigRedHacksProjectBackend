export const SESSION_EVENT_TYPES = [
  "focus_sample",
  "break_started",
  "break_ended",
  "coach_spoke",
  "user_spoke",
  "distraction",
  "session_ended",
] as const;

export type ParsedSession = {
  goals: string;
  durationSecs: number;
  modality: string;
};

export type ParsedEvent = {
  type: (typeof SESSION_EVENT_TYPES)[number];
  at: string;
  payload: Record<string, unknown>;
};

function record(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}

function payloadObject(value: unknown): Record<string, unknown> | null {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function isEventType(value: string): value is ParsedEvent["type"] {
  return (SESSION_EVENT_TYPES as readonly string[]).includes(value);
}

export function parseCreateSession(
  body: unknown,
): { ok: true; value: ParsedSession } | { ok: false; message: string } {
  const input = record(body);
  if (!input) return { ok: false, message: "Session body must be an object." };
  if (typeof input.goals !== "string" || input.goals.trim().length === 0) {
    return { ok: false, message: "goals must be a non-empty string." };
  }
  if (
    typeof input.duration_secs !== "number" ||
    !Number.isFinite(input.duration_secs) ||
    input.duration_secs <= 0
  ) {
    return { ok: false, message: "duration_secs must be a positive number." };
  }
  if (typeof input.modality !== "string") {
    return { ok: false, message: "modality must be a string." };
  }
  return {
    ok: true,
    value: {
      goals: input.goals.trim(),
      durationSecs: input.duration_secs,
      modality: input.modality,
    },
  };
}

export function parseSessionEvent(
  body: unknown,
  now: Date,
): { ok: true; value: ParsedEvent } | { ok: false; message: string } {
  const input = record(body);
  if (!input) return { ok: false, message: "Event body must be an object." };
  if (typeof input.type !== "string" || !isEventType(input.type)) {
    return { ok: false, message: "type is not a session event." };
  }
  let at: string;
  if (input.at === undefined) {
    at = now.toISOString();
  } else {
    const parsed = isoTimestamp(input.at);
    if (!parsed) return { ok: false, message: "at must be an ISO timestamp." };
    at = parsed;
  }
  const payload = payloadObject(input.payload);
  if (!payload) return { ok: false, message: "payload must be an object." };
  if (input.type === "focus_sample") {
    const focus = payload.focus;
    if (typeof focus !== "number" || !Number.isFinite(focus) || focus < 0 || focus > 1) {
      return { ok: false, message: "focus must be a number from 0 to 1." };
    }
  }
  return { ok: true, value: { type: input.type, at, payload } };
}
