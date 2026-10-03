import type { SessionEventRecord, StudySessionRecord } from "../store/types.ts";

export type SessionSummary = {
  session_id: string;
  goals: string;
  time_spent_secs: number;
  break_secs: number;
  attention_level: number | null;
  event_count: number;
};

function byTime(events: SessionEventRecord[]): SessionEventRecord[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      const delta = Date.parse(a.event.at) - Date.parse(b.event.at);
      return delta !== 0 ? delta : a.index - b.index;
    })
    .map((item) => item.event);
}

function attentionLevel(events: SessionEventRecord[]): number | null {
  const samples: number[] = [];
  for (const event of events) {
    if (event.type !== "focus_sample") continue;
    const focus = event.payload.focus;
    if (typeof focus === "number" && Number.isFinite(focus)) samples.push(focus);
  }
  if (samples.length === 0) return null;
  const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  return Math.round(average * 1_000_000) / 1_000_000;
}

export function summarizeSession(
  session: StudySessionRecord,
  events: SessionEventRecord[],
  now: Date,
): SessionSummary {
  const ordered = byTime(events);
  const startedMs = Date.parse(session.started_at);
  const ended = ordered.find((event) => event.type === "session_ended");
  const endMs = ended ? Date.parse(ended.at) : now.getTime();

  let breakMs = 0;
  let openMs: number | null = null;
  for (const event of ordered) {
    const atMs = Date.parse(event.at);
    if (event.type === "break_started") {
      if (openMs === null && atMs < endMs) {
        const start = Math.max(atMs, startedMs);
        openMs = start < endMs ? start : null;
      }
      continue;
    }
    if (event.type === "break_ended" && openMs !== null) {
      const closeMs = Math.min(atMs, endMs);
      if (closeMs > openMs) breakMs += closeMs - openMs;
      openMs = null;
    }
  }
  if (openMs !== null && endMs > openMs) breakMs += endMs - openMs;

  const elapsedMs = Math.max(0, endMs - startedMs);
  const timeSpentMs = Math.max(0, elapsedMs - breakMs);

  return {
    session_id: session.id,
    goals: session.goals,
    time_spent_secs: timeSpentMs / 1000,
    break_secs: breakMs / 1000,
    attention_level: attentionLevel(ordered),
    event_count: events.length,
  };
}
