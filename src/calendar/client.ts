import { HttpError } from "../http.ts";
import type { RawEvent } from "./classify.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3/calendars";
const CALENDAR = `${CALENDAR_BASE}/primary/events`;
const CALENDAR_LIST = "https://www.googleapis.com/calendar/v3/users/me/calendarList";

/** How many pages of events we follow per calendar before giving up. */
const MAX_EVENT_PAGES = 5;

export type CalendarRef = {
  id: string;
  summary: string;
  primary: boolean;
  selected: boolean;
};

export type ListEventsOptions = {
  /** Calendar to read. Defaults to `primary`. */
  calendarId?: string;
  /** IANA zone — Google renders `dateTime` fields in it, so local days line up. */
  timeZone?: string;
  /** Safety cap across all pages. */
  maxEvents?: number;
};

export type CalendarClient = {
  refresh(input: { refreshToken: string; clientId: string; clientSecret: string }): Promise<string>;
  listEvents(
    accessToken: string,
    timeMin: string,
    timeMax: string,
    options?: ListEventsOptions,
  ): Promise<RawEvent[]>;
  /**
   * Calendars the student subscribes to. Optional: needs `calendar.readonly`, so
   * grants issued before that scope was requested fall back to `primary` only.
   */
  listCalendars?(accessToken: string): Promise<CalendarRef[]>;
  insertEvent(accessToken: string, body: unknown): Promise<RawEvent>;
  getEvent(accessToken: string, id: string): Promise<RawEvent>;
  patchEvent(accessToken: string, id: string, body: unknown): Promise<RawEvent>;
  deleteEvent(accessToken: string, id: string): Promise<void>;
};

/**
 * Read every calendar the student has selected, tagging each event with its
 * calendar name. Falls back to `primary` when calendar listing isn't permitted,
 * so a class calendar on a secondary subscription is no longer invisible.
 */
export async function listEventsAcrossCalendars(
  client: CalendarClient,
  accessToken: string,
  timeMin: string,
  timeMax: string,
  timeZone: string,
): Promise<RawEvent[]> {
  let calendars: CalendarRef[] = [];
  if (typeof client.listCalendars === "function") {
    calendars = await client.listCalendars(accessToken).catch(() => []);
  }
  const selected = calendars.filter((cal) => cal.selected).slice(0, 12);
  if (selected.length === 0) {
    return client.listEvents(accessToken, timeMin, timeMax, { timeZone });
  }
  const batches = await Promise.all(
    selected.map(async (cal) => {
      const events = await client
        .listEvents(accessToken, timeMin, timeMax, { calendarId: cal.id, timeZone })
        .catch(() => [] as RawEvent[]);
      return cal.primary
        ? events
        : events.map((event) => ({ ...event, calendarName: cal.summary }));
    }),
  );
  const seen = new Set<string>();
  const merged: RawEvent[] = [];
  for (const event of batches.flat()) {
    const key = event.id ? `${event.calendarName ?? ""}:${event.id}` : JSON.stringify(event);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(event);
  }
  return merged;
}

function failed(status: number): HttpError {
  return new HttpError(502, "calendar_unavailable", `Calendar request failed (${status}).`);
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

export function createCalendarClient(fetchImpl: typeof fetch = fetch): CalendarClient {
  return {
    async refresh(input) {
      const response = await fetchImpl(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: input.refreshToken,
          client_id: input.clientId,
          client_secret: input.clientSecret,
        }),
      });
      const payload = (await readJson(response)) as { access_token?: string } | null;
      if (!response.ok || !payload?.access_token) throw failed(response.status);
      return payload.access_token;
    },
    async listEvents(accessToken, timeMin, timeMax, options = {}) {
      const calendarId = options.calendarId?.trim() || "primary";
      const maxEvents = Math.max(1, options.maxEvents ?? 1_000);
      const events: RawEvent[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
        const url = new URL(`${CALENDAR_BASE}/${encodeURIComponent(calendarId)}/events`);
        url.searchParams.set("singleEvents", "true");
        url.searchParams.set("orderBy", "startTime");
        url.searchParams.set("timeMin", timeMin);
        url.searchParams.set("timeMax", timeMax);
        url.searchParams.set("maxResults", "250");
        // Cancelled instances of recurring events would otherwise look like real work.
        url.searchParams.set("showDeleted", "false");
        if (options.timeZone) url.searchParams.set("timeZone", options.timeZone);
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const response = await fetchImpl(url, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const payload = (await readJson(response)) as
          | { items?: RawEvent[]; nextPageToken?: string }
          | null;
        if (!response.ok) throw failed(response.status);
        for (const item of payload?.items ?? []) {
          if (item.status === "cancelled") continue;
          events.push(item);
        }
        pageToken = payload?.nextPageToken;
        if (!pageToken || events.length >= maxEvents) break;
      }
      return events.slice(0, maxEvents);
    },
    async listCalendars(accessToken) {
      const url = new URL(CALENDAR_LIST);
      url.searchParams.set("maxResults", "250");
      url.searchParams.set("minAccessRole", "reader");
      url.searchParams.set("showDeleted", "false");
      url.searchParams.set("showHidden", "false");
      const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      const payload = (await readJson(response)) as
        | { items?: Array<Record<string, unknown>> }
        | null;
      if (!response.ok) throw failed(response.status);
      const items = Array.isArray(payload?.items) ? payload.items : [];
      return items
        .filter((item) => typeof item.id === "string")
        .map((item) => ({
          id: String(item.id),
          summary:
            typeof item.summaryOverride === "string" && item.summaryOverride.trim()
              ? item.summaryOverride
              : typeof item.summary === "string"
                ? item.summary
                : String(item.id),
          primary: item.primary === true,
          // Google omits `selected` for the primary calendar; absent means shown.
          selected: item.selected !== false,
        }));
    },
    async insertEvent(accessToken, body) {
      const response = await fetchImpl(CALENDAR, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await readJson(response)) as RawEvent | null;
      if (!response.ok || !payload) throw failed(response.status);
      return payload;
    },
    async getEvent(accessToken, id) {
      const response = await fetchImpl(`${CALENDAR}/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const payload = (await readJson(response)) as RawEvent | null;
      if (response.status === 404) throw new HttpError(404, "event_not_found", "Calendar event was not found.");
      if (!response.ok || !payload) throw failed(response.status);
      return payload;
    },
    async patchEvent(accessToken, id, body) {
      const response = await fetchImpl(`${CALENDAR}/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await readJson(response)) as RawEvent | null;
      if (!response.ok || !payload) throw failed(response.status);
      return payload;
    },
    async deleteEvent(accessToken, id) {
      const response = await fetchImpl(`${CALENDAR}/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (response.status === 404) throw new HttpError(404, "event_not_found", "Calendar event was not found.");
      if (!response.ok && response.status !== 204) throw failed(response.status);
    },
  };
}
