/**
 * Timezone-aware calendar windowing and summary rendering.
 *
 * The desktop sends its IANA zone; everything the model reads is labelled in that
 * zone so "tomorrow" means the student's tomorrow, not the server's UTC day.
 */

import type { RawEvent } from "./classify.ts";

export const DEFAULT_WINDOW_DAYS = 14;
export const MAX_WINDOW_DAYS = 60;

export type CalendarWindow = {
  timeMin: string;
  timeMax: string;
  timeZone: string;
  days: number;
  /** Local "YYYY-MM-DD" for today / tomorrow / the last day in the window. */
  todayKey: string;
  tomorrowKey: string;
  lastKey: string;
};

export function normalizeTimeZone(value: unknown): string {
  const tz = typeof value === "string" ? value.trim() : "";
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

function partsIn(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const read = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour") % 24,
    minute: read("minute"),
    second: read("second"),
  };
}

/** Offset of `timeZone` from UTC at `date`, in milliseconds (positive east of UTC). */
export function zoneOffsetMs(date: Date, timeZone: string): number {
  const p = partsIn(date, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - date.getTime();
}

/** Local calendar day of an instant, as "YYYY-MM-DD". */
export function dateKeyIn(date: Date, timeZone: string): string {
  const p = partsIn(date, timeZone);
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function addDaysToKey(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const next = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

/** Instant of local midnight starting `key` in `timeZone`. Converges across DST shifts. */
export function startOfLocalDay(key: string, timeZone: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  const wall = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  let ts = wall;
  for (let i = 0; i < 3; i += 1) {
    const offset = zoneOffsetMs(new Date(ts), timeZone);
    const next = wall - offset;
    if (next === ts) break;
    ts = next;
  }
  return new Date(ts);
}

/**
 * Window anchored to the student's local days, not a rolling 24h multiple.
 * Starts at local midnight today (so "today" is complete) and ends at local
 * midnight *after* the last day, so the final day is never half-included.
 */
export function calendarWindow(now: Date, days: number, timeZoneInput: unknown): CalendarWindow {
  const timeZone = normalizeTimeZone(timeZoneInput);
  const span = Math.max(1, Math.min(MAX_WINDOW_DAYS, Math.floor(days) || DEFAULT_WINDOW_DAYS));
  const todayKey = dateKeyIn(now, timeZone);
  const tomorrowKey = addDaysToKey(todayKey, 1);
  const lastKey = addDaysToKey(todayKey, span - 1);
  return {
    timeMin: startOfLocalDay(todayKey, timeZone).toISOString(),
    timeMax: startOfLocalDay(addDaysToKey(lastKey, 1), timeZone).toISOString(),
    timeZone,
    days: span,
    todayKey,
    tomorrowKey,
    lastKey,
  };
}

export type DatedEvent = {
  key: string;
  allDay: boolean;
  start: Date | null;
  label: string;
  title: string;
  location: string | null;
  calendar: string | null;
  past: boolean;
};

function weekdayLabel(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }).format(date);
  const month = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short" }).format(date);
  return `${weekday}, ${month} ${date.getUTCDate()} (${key})`;
}

function timeLabel(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

/** Bucket events into local day keys. All-day events use their literal date. */
export function datedEvents(events: RawEvent[], now: Date, timeZone: string): DatedEvent[] {
  const out: DatedEvent[] = [];
  for (const event of events) {
    const title = (event.summary ?? "(untitled)").trim() || "(untitled)";
    const location = typeof event.location === "string" && event.location.trim()
      ? event.location.trim()
      : null;
    const calendar = typeof event.calendarName === "string" && event.calendarName.trim()
      ? event.calendarName.trim()
      : null;
    const startDate = event.start?.date;
    if (startDate && !event.start?.dateTime) {
      out.push({
        key: startDate,
        allDay: true,
        start: null,
        label: "all day",
        title,
        location,
        calendar,
        past: false,
      });
      continue;
    }
    const iso = event.start?.dateTime;
    const parsed = iso ? new Date(iso) : null;
    if (!parsed || Number.isNaN(parsed.getTime())) continue;
    const endIso = event.end?.dateTime;
    const end = endIso ? new Date(endIso) : null;
    const endLabel = end && !Number.isNaN(end.getTime()) ? `–${timeLabel(end, timeZone)}` : "";
    out.push({
      key: dateKeyIn(parsed, timeZone),
      allDay: false,
      start: parsed,
      label: `${timeLabel(parsed, timeZone)}${endLabel}`,
      title,
      location,
      calendar,
      past: (end ?? parsed).getTime() < now.getTime(),
    });
  }
  return out.sort((a, b) => {
    if (a.key !== b.key) return a.key < b.key ? -1 : 1;
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    return (a.start?.getTime() ?? 0) - (b.start?.getTime() ?? 0);
  });
}

export type SummaryOptions = {
  /** Cap on events rendered for days after tomorrow. Today/tomorrow are never cut. */
  maxLaterEvents?: number;
};

function renderDay(items: DatedEvent[]): string[] {
  return items.map((item) => {
    const where = item.location ? ` — ${item.location}` : "";
    const cal = item.calendar ? ` [${item.calendar}]` : "";
    const past = item.past ? " (already passed)" : "";
    return `- ${item.label}: ${item.title}${where}${cal}${past}`;
  });
}

/**
 * Render the window with explicit TODAY / TOMORROW sections. Today and tomorrow
 * are always complete — only later days get trimmed by the cap.
 */
export function formatCalendarSummary(
  events: RawEvent[],
  window: CalendarWindow,
  now: Date,
  options: SummaryOptions = {},
): string {
  const maxLater = Math.max(0, options.maxLaterEvents ?? 60);
  const dated = datedEvents(events, now, window.timeZone).filter(
    (item) => item.key >= window.todayKey && item.key <= window.lastKey,
  );
  const nowLabel = `${weekdayLabel(window.todayKey)} ${timeLabel(now, window.timeZone)}`;
  const header = `UPCOMING CALENDAR — next ${window.days} day(s) through ${window.lastKey}, in the student's timezone ${window.timeZone}. Right now it is ${nowLabel}. This window always includes TODAY and TOMORROW.`;

  if (dated.length === 0) {
    return `${header}\n(no events on any connected calendar in this window)`;
  }

  const byDay = new Map<string, DatedEvent[]>();
  for (const item of dated) {
    const bucket = byDay.get(item.key);
    if (bucket) bucket.push(item);
    else byDay.set(item.key, [item]);
  }

  const sections: string[] = [];
  const today = byDay.get(window.todayKey) ?? [];
  sections.push(
    `TODAY — ${weekdayLabel(window.todayKey)}:\n${
      today.length ? renderDay(today).join("\n") : "- (nothing scheduled)"
    }`,
  );
  const tomorrow = byDay.get(window.tomorrowKey) ?? [];
  sections.push(
    `TOMORROW — ${weekdayLabel(window.tomorrowKey)}:\n${
      tomorrow.length ? renderDay(tomorrow).join("\n") : "- (nothing scheduled)"
    }`,
  );

  const laterKeys = [...byDay.keys()]
    .filter((key) => key > window.tomorrowKey)
    .sort();
  const laterBlocks: string[] = [];
  let rendered = 0;
  let omitted = 0;
  for (const key of laterKeys) {
    const items = byDay.get(key)!;
    if (rendered >= maxLater) {
      omitted += items.length;
      continue;
    }
    const room = maxLater - rendered;
    const shown = items.slice(0, room);
    omitted += items.length - shown.length;
    rendered += shown.length;
    laterBlocks.push(`${weekdayLabel(key)}:\n${renderDay(shown).join("\n")}`);
  }
  if (laterBlocks.length > 0) {
    sections.push(`LATER IN THIS WINDOW:\n${laterBlocks.join("\n")}`);
  }
  if (omitted > 0) {
    sections.push(`(${omitted} further event(s) in this window were not listed.)`);
  }
  return `${header}\n\n${sections.join("\n\n")}`;
}
