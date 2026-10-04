import assert from "node:assert/strict";
import test from "node:test";

import type { RawEvent } from "../src/calendar/classify.ts";
import {
  addDaysToKey,
  calendarWindow,
  dateKeyIn,
  formatCalendarSummary,
  normalizeTimeZone,
  startOfLocalDay,
} from "../src/calendar/window.ts";
import { listEventsAcrossCalendars, type CalendarClient } from "../src/calendar/client.ts";

const NY = "America/New_York";

test("normalizeTimeZone falls back to UTC for junk", () => {
  assert.equal(normalizeTimeZone(NY), NY);
  assert.equal(normalizeTimeZone("Not/AZone"), "UTC");
  assert.equal(normalizeTimeZone(null), "UTC");
  assert.equal(normalizeTimeZone(""), "UTC");
});

test("late-evening local time still resolves today/tomorrow in the student's zone", () => {
  // 01:30 UTC on Oct 4 is still 21:30 on Oct 3 in New York. A UTC-anchored window
  // would call Oct 4 "today" and silently skip the student's real tomorrow.
  const now = new Date("2026-10-04T01:30:00.000Z");
  assert.equal(dateKeyIn(now, NY), "2026-10-03");
  const window = calendarWindow(now, 14, NY);
  assert.equal(window.todayKey, "2026-10-03");
  assert.equal(window.tomorrowKey, "2026-10-04");
  assert.equal(window.lastKey, "2026-10-16");
  // Window starts at local midnight today, not at `now`.
  assert.equal(window.timeMin, "2026-10-03T04:00:00.000Z");
  // …and runs through the end of the last local day, so it is never half-included.
  assert.equal(window.timeMax, "2026-10-17T04:00:00.000Z");
});

test("window covers whole local days across a DST transition", () => {
  // US DST ends Nov 1 2026; the window must still land on local midnight.
  const now = new Date("2026-10-30T15:00:00.000Z");
  const window = calendarWindow(now, 7, NY);
  assert.equal(window.todayKey, "2026-10-30");
  assert.equal(startOfLocalDay("2026-10-31", NY).toISOString(), "2026-10-31T04:00:00.000Z");
  assert.equal(startOfLocalDay("2026-11-02", NY).toISOString(), "2026-11-02T05:00:00.000Z");
  assert.equal(window.timeMax, "2026-11-06T05:00:00.000Z");
});

test("addDaysToKey rolls over month boundaries", () => {
  assert.equal(addDaysToKey("2026-10-31", 1), "2026-11-01");
  assert.equal(addDaysToKey("2026-01-01", -1), "2025-12-31");
});

test("summary always labels TODAY and TOMORROW, even when they are empty", () => {
  const now = new Date("2026-10-04T01:30:00.000Z"); // Oct 3, 21:30 in NY
  const window = calendarWindow(now, 14, NY);
  const summary = formatCalendarSummary([], window, now);
  assert.match(summary, /America\/New_York/);
  assert.match(summary, /no events on any connected calendar/);

  const withEvents = formatCalendarSummary(
    [
      {
        id: "e1",
        summary: "ECON 1110 Prelim",
        location: "Statler Hall",
        start: { dateTime: "2026-10-04T13:05:00.000Z" }, // 09:05 NY, i.e. tomorrow
        end: { dateTime: "2026-10-04T13:55:00.000Z" },
      },
    ],
    window,
    now,
  );
  assert.match(withEvents, /TODAY — Saturday, Oct 3 \(2026-10-03\):\n- \(nothing scheduled\)/);
  assert.match(withEvents, /TOMORROW — Sunday, Oct 4 \(2026-10-04\):/);
  assert.match(withEvents, /ECON 1110 Prelim — Statler Hall/);
});

test("all-day events land on their literal date and tomorrow is never truncated", () => {
  const now = new Date("2026-10-03T14:00:00.000Z");
  const window = calendarWindow(now, 14, NY);
  const events: RawEvent[] = [
    { id: "allday", summary: "Essay due", start: { date: "2026-10-04" }, end: { date: "2026-10-05" } },
  ];
  // 40 later-day events would have pushed tomorrow out of an older 12-event slice.
  for (let i = 0; i < 40; i += 1) {
    events.push({
      id: `filler-${i}`,
      summary: `Filler ${i}`,
      start: { dateTime: "2026-10-09T15:00:00.000Z" },
      end: { dateTime: "2026-10-09T16:00:00.000Z" },
    });
  }
  const summary = formatCalendarSummary(events, window, now, { maxLaterEvents: 5 });
  assert.match(summary, /TOMORROW — Sunday, Oct 4 \(2026-10-04\):\n- all day: Essay due/);
  assert.match(summary, /further event\(s\) in this window were not listed/);
});

test("cancelled-free merge tags secondary calendars and falls back to primary", async () => {
  const calls: string[] = [];
  const base: CalendarClient = {
    async refresh() {
      return "access";
    },
    async listEvents(_token, _min, _max, options) {
      calls.push(options?.calendarId ?? "primary");
      return [{ id: `evt-${options?.calendarId ?? "primary"}`, summary: "Lecture" }];
    },
    async insertEvent() {
      return {};
    },
    async getEvent() {
      return {};
    },
    async patchEvent() {
      return {};
    },
    async deleteEvent() {},
  };

  const withList: CalendarClient = {
    ...base,
    async listCalendars() {
      return [
        { id: "primary", summary: "Me", primary: true, selected: true },
        { id: "course@group", summary: "ECON 1110", primary: false, selected: true },
        { id: "hidden@group", summary: "Holidays", primary: false, selected: false },
      ];
    },
  };
  const merged = await listEventsAcrossCalendars(withList, "tok", "a", "b", NY);
  assert.deepEqual(calls.sort(), ["course@group", "primary"]);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((e) => e.calendarName)?.calendarName, "ECON 1110");

  // No calendar.readonly scope → listCalendars rejects → primary still works.
  calls.length = 0;
  const denied: CalendarClient = {
    ...base,
    async listCalendars() {
      throw new Error("insufficient scope");
    },
  };
  const fallback = await listEventsAcrossCalendars(denied, "tok", "a", "b", NY);
  assert.deepEqual(calls, ["primary"]);
  assert.equal(fallback.length, 1);
});
