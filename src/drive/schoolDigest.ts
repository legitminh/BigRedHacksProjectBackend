/**
 * Once-per-local-day school digest (Gemini overview / Flash — single call per digest_date).
 */

import type { CalendarClient } from "../calendar/client.ts";
import { listEventsAcrossCalendars } from "../calendar/client.ts";
import {
  calendarWindow,
  dateKeyIn,
  formatCalendarSummary,
  normalizeTimeZone,
} from "../calendar/window.ts";
import type { Config } from "../config.ts";
import type { DriveClient } from "../drive/client.ts";
import { INVENTORY_DEFAULT_MAX_FILES } from "../drive/client.ts";
import { readFileTextCached } from "../drive/cache.ts";
import type { FetchLike } from "../gemini/ephemeral.ts";
import { geminiChat } from "../gemini/chat.ts";
import type { SchoolDigest, SchoolDigestSource, Store } from "../store/types.ts";
import {
  collectSearchHits,
  DEEP_BRIEF_LOAD_CONCURRENCY,
  DEEP_BRIEF_MAX_CHARS_PER_FILE,
  selectFilesForBrief,
} from "./weekBrief.ts";

export const SCHOOL_DIGEST_WINDOW_DAYS = 21;
export const SCHOOL_DIGEST_MAX_FILES = 12;
export const SCHOOL_DIGEST_MAX_TEXT = 80_000;

const DIGEST_UTTERANCE =
  "syllabus assignments homework due dates exams grading weights this week and next three weeks all courses";

export type BuildSchoolDigestInput = {
  drive: DriveClient;
  calendar: CalendarClient;
  store: Store;
  userId: string;
  accessToken: string;
  timeZone: string;
  now: Date;
  geminiApiKey: string;
  overviewModel: string;
  fetchImpl?: FetchLike;
  /** Tests: override Gemini digest generation. */
  generateDigest?: (prompt: string) => Promise<string>;
};

export type EnsureSchoolDigestInput = BuildSchoolDigestInput & {
  force?: boolean;
};

function clipDigest(text: string): string {
  const t = text.trim();
  if (t.length <= SCHOOL_DIGEST_MAX_TEXT) return t;
  return `${t.slice(0, SCHOOL_DIGEST_MAX_TEXT - 1).trimEnd()}…`;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length || 1) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

const DIGEST_SYSTEM = `You write a structured markdown SCHOOL DIGEST for a student coach.
Use ONLY the calendar and file texts provided. Do NOT invent due dates, weights, or courses.
Sections (markdown headings):
## THIS WEEK (due dates)
Every item with exact date and source filename.
## LATER (due dates)
Beyond this week, within the calendar window.
## PER-COURSE (grading / exams)
From syllabi when present.
## GAPS
Missing syllabi, unreadable files, or unknown courses.
If a fact is not in the inputs, put it under GAPS — never guess.`;

export async function buildSchoolDigest(input: BuildSchoolDigestInput): Promise<SchoolDigest> {
  const timeZone = normalizeTimeZone(input.timeZone);
  const digestDate = dateKeyIn(input.now, timeZone);
  const window = calendarWindow(input.now, SCHOOL_DIGEST_WINDOW_DAYS, timeZone);
  const events = await listEventsAcrossCalendars(
    input.calendar,
    input.accessToken,
    window.timeMin,
    window.timeMax,
    window.timeZone,
  );
  const calendarSummary = formatCalendarSummary(events, window, input.now);

  const page = await input.drive.inventory(input.accessToken, {
    maxFiles: INVENTORY_DEFAULT_MAX_FILES,
    includeFolderPaths: true,
  });
  const searchHits = await collectSearchHits(
    input.drive,
    input.accessToken,
    DIGEST_UTTERANCE,
    page.files,
  );
  const selected = selectFilesForBrief({
    inventoryFiles: page.files,
    calendarSummary,
    utterance: DIGEST_UTTERANCE,
    searchHits,
  }).slice(0, SCHOOL_DIGEST_MAX_FILES);

  const loaded = await mapWithConcurrency(
    selected,
    DEEP_BRIEF_LOAD_CONCURRENCY,
    async (file) => {
      const result = await readFileTextCached(
        input.drive,
        input.store,
        input.userId,
        input.accessToken,
        file,
        DEEP_BRIEF_MAX_CHARS_PER_FILE,
      );
      return { file, result };
    },
  );

  const sources: SchoolDigestSource[] = [];
  const fileBlocks: string[] = [];
  for (const { file, result } of loaded) {
    sources.push({ id: file.id, name: file.name });
    if (result.ok) {
      fileBlocks.push(`### ${file.name}\n${result.text}`);
    } else {
      fileBlocks.push(`### ${file.name}\n(FAILED TO LOAD: ${result.reason})`);
    }
  }

  const prompt = [
    `Timezone: ${timeZone}`,
    `Digest date (local): ${digestDate}`,
    "",
    "CALENDAR:",
    calendarSummary,
    "",
    "DRIVE FILES (full text):",
    fileBlocks.join("\n\n") || "(no syllabus files selected)",
    "",
    "Write the school digest markdown now.",
  ].join("\n");

  const digestText = clipDigest(
    input.generateDigest
      ? await input.generateDigest(prompt)
      : await geminiChat({
          apiKey: input.geminiApiKey,
          model: input.overviewModel,
          system: DIGEST_SYSTEM,
          history: [],
          message: prompt,
          fetchImpl: input.fetchImpl ?? globalThis.fetch.bind(globalThis),
        }),
  );

  const nowIso = input.now.toISOString();
  return {
    userId: input.userId,
    digestDate,
    timezone: timeZone,
    model: input.overviewModel,
    digestText,
    sources,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

export async function ensureSchoolDigest(input: EnsureSchoolDigestInput): Promise<SchoolDigest> {
  const timeZone = normalizeTimeZone(input.timeZone);
  const digestDate = dateKeyIn(input.now, timeZone);

  if (!input.force) {
    const existing = await input.store.getSchoolDigest(input.userId, digestDate);
    if (existing) return existing;
  }

  const built = await buildSchoolDigest(input);
  const again = !input.force
    ? await input.store.getSchoolDigest(input.userId, digestDate)
    : null;
  if (again && !input.force) return again;

  await input.store.upsertSchoolDigest(built);
  const row = await input.store.getSchoolDigest(input.userId, digestDate);
  return row ?? built;
}

export function schoolDigestContextFields(
  digest: SchoolDigest | null,
): { school_digest?: string; school_digest_date?: string } {
  if (!digest?.digestText?.trim()) return {};
  return {
    school_digest: digest.digestText,
    school_digest_date: digest.digestDate,
  };
}

export async function loadSchoolDigestForChat(
  store: Store,
  userId: string,
  timeZone: unknown,
  now: Date,
): Promise<SchoolDigest | null> {
  const tz = normalizeTimeZone(timeZone);
  const digestDate = dateKeyIn(now, tz);
  return store.getSchoolDigest(userId, digestDate);
}

export function schoolDigestFromConfig(config: Pick<Config, "geminiApiKey" | "geminiOverviewModel">): {
  canBuild: boolean;
  overviewModel: string;
} {
  return {
    canBuild: Boolean(config.geminiApiKey?.trim()),
    overviewModel: config.geminiOverviewModel,
  };
}
