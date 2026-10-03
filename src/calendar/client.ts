import { HttpError } from "../http.ts";
import type { RawEvent } from "./classify.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

export type CalendarClient = {
  refresh(input: { refreshToken: string; clientId: string; clientSecret: string }): Promise<string>;
  listEvents(accessToken: string, timeMin: string, timeMax: string): Promise<RawEvent[]>;
  insertEvent(accessToken: string, body: unknown): Promise<RawEvent>;
  getEvent(accessToken: string, id: string): Promise<RawEvent>;
  patchEvent(accessToken: string, id: string, body: unknown): Promise<RawEvent>;
  deleteEvent(accessToken: string, id: string): Promise<void>;
};

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
    async listEvents(accessToken, timeMin, timeMax) {
      const url = new URL(CALENDAR);
      url.searchParams.set("singleEvents", "true");
      url.searchParams.set("orderBy", "startTime");
      url.searchParams.set("timeMin", timeMin);
      url.searchParams.set("timeMax", timeMax);
      url.searchParams.set("maxResults", "250");
      const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      const payload = (await readJson(response)) as { items?: RawEvent[] } | null;
      if (!response.ok) throw failed(response.status);
      return payload?.items ?? [];
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
