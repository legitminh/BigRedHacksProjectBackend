const DEADLINE = /\b(due|deadline|submit|exam|quiz|prelim|midterm|final|hw|pset|assignment)\b/i;

export type RawEvent = {
  id?: string;
  summary?: string;
  location?: string;
  htmlLink?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  status?: string;
  extendedProperties?: { private?: Record<string, string> };
  /** Set by the client when events are merged from more than one calendar. */
  calendarName?: string;
};

export type DeadlineItem = {
  id: string;
  title: string;
  due: string;
  all_day: boolean;
  waypoint: boolean;
};

export type BlockItem = {
  id: string;
  title: string;
  start: string;
  end: string;
  waypoint: boolean;
};

export function isWaypoint(event: RawEvent): boolean {
  return event.extendedProperties?.private?.waypoint === "1";
}

export function classifyAgenda(events: RawEvent[]): { deadlines: DeadlineItem[]; blocks: BlockItem[] } {
  const deadlines: DeadlineItem[] = [];
  const blocks: BlockItem[] = [];
  for (const event of events) {
    const id = event.id ?? "";
    const title = event.summary ?? "(untitled)";
    const allDay = Boolean(event.start?.date) && !event.start?.dateTime;
    const waypoint = isWaypoint(event);
    if (allDay || DEADLINE.test(title)) {
      const due = event.start?.date ?? event.start?.dateTime?.slice(0, 10) ?? "";
      deadlines.push({ id, title, due, all_day: allDay, waypoint });
    } else {
      blocks.push({
        id,
        title,
        start: event.start?.dateTime ?? "",
        end: event.end?.dateTime ?? "",
        waypoint,
      });
    }
  }
  return { deadlines, blocks };
}

export function studyBlockMinutes(start: string, end: string): number | null {
  const from = Date.parse(start);
  const to = Date.parse(end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
  return Math.round((to - from) / 60000);
}

export function dateOnly(value: string): string | null {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return new Date(parsed).toISOString().slice(0, 10);
}

export function nextDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map((part) => Number(part));
  const date = new Date(Date.UTC(year!, (month ?? 1) - 1, day ?? 1));
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}
