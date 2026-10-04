/**
 * Conversational Drive lookup for a single Copilot/Live turn.
 * Resolves “open it / yes / check my syllabi” against prior chat + inventory,
 * then loads full file text (not a tease / not a promise to fetch later).
 */

import type { FetchLike } from "../http.ts";
import type { Store } from "../store/types.ts";
import type { DriveClient, DriveFile } from "./client.ts";
import { summarizeDriveFilesWithExcerpts } from "./client.ts";
import { readFileTextCached } from "./cache.ts";
import { prepareLiteDepthContext } from "./liteDepth.ts";
import { isDeepOverviewIntent } from "./weekBrief.ts";

export { isDeepOverviewIntent } from "./weekBrief.ts";

/** Soft confirm / open / pull-up. */
const OPEN_CONFIRM =
  /^(yep|yes|yeah|yup|please|ok|okay|sure|do it|go ahead|open it|open that|read it|read that|pull (?:it|them|that) up)\b/i;
const OPEN_VERB =
  /\b(open|read|look (?:in|at|inside)|show me|pull up|pull(?:\s+\w+){0,3}\s+contents?|check|run through|go through|scan)\b/i;
/** Student is asking what is due / to verify assignments from syllabi. */
const SYLLABUS_CHECK =
  /\b(syllab|assignment|due date|what(?:'s| is) due|this week|next week|prelim|midterm|problem set|homework|hw\b|ps\d)\b/i;
const COURSE_CODE = /\b[A-Z]{2,6}\s?-?\s?\d{3,4}[A-Z]?\b/g;

/** Full-content budget for intentional opens / syllabus checks. */
export const FULL_FILE_CHARS = 80_000;
export const FULL_FILE_COUNT = 8;

export function looksLikeOpenOrConfirm(text: string): boolean {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return false;
  if (t.length <= 96 && OPEN_CONFIRM.test(t)) return true;
  return OPEN_VERB.test(t);
}

export function looksLikeSyllabusCheck(text: string): boolean {
  return SYLLABUS_CHECK.test(text);
}

export function wantsFullDriveLoad(text: string): boolean {
  return looksLikeOpenOrConfirm(text) || looksLikeSyllabusCheck(text);
}

/** Parse file titles out of a DRIVE INVENTORY block (names before ` (` ). */
export function inventoryFileNames(inventory: string): string[] {
  if (!inventory?.trim()) return [];
  const names: string[] = [];
  // `folder/ — File A (pdf), File B (docx)` or `- File (mime…)`
  for (const line of inventory.split("\n")) {
    const dash = line.match(/—\s*(.+)$/);
    const body = dash?.[1] ?? (line.trim().startsWith("- ") ? line.trim().slice(2) : "");
    if (!body) continue;
    for (const part of body.split(",")) {
      const name = part.replace(/\s*\([^)]*\)\s*$/, "").trim();
      if (name.length >= 3 && name.length <= 180) names.push(name);
    }
  }
  return uniqueStrings(names);
}

export function fileMentions(text: string): string[] {
  const found: string[] = [];
  const titled =
    text.match(
      /\b([A-Z][A-Za-z0-9][\w./&'’ -]{1,70}?(?:syllabus|inventory|roster|notes|slides|outline|policies|expectations|midterm|final|exam|ps\d+|hw\d+))\b/gi,
    ) ?? [];
  found.push(...titled.map((s) => s.trim()));
  const files = text.match(/\b[\w.-]+\.(?:pdf|docx?|xlsx?|csv|pptx?|txt)\b/gi) ?? [];
  found.push(...files);
  for (const m of text.matchAll(/[“"]([^”"]{3,80})[”"]/g)) {
    if (m[1]) found.push(m[1].trim());
  }
  const codes = text.match(COURSE_CODE) ?? [];
  found.push(...codes.map((c) => c.replace(/\s+/g, " ").trim()));
  return uniqueStrings(found);
}

/** Build one or more Drive search strings for this utterance. */
export function driveSearchQueries(
  utterance: string,
  priorTurns: ReadonlyArray<{ role: string; content: string }> = [],
  inventory = "",
): string[] {
  const primary = utterance.trim().replace(/\s+/g, " ");
  if (!primary) return [];
  const out: string[] = [primary];
  const expand = wantsFullDriveLoad(primary) || isDeepOverviewIntent(primary);

  if (expand) {
    for (const turn of [...priorTurns].reverse()) {
      const content = turn.content?.trim().replace(/\s+/g, " ");
      if (!content || content.length < 4) continue;
      if (turn.role === "user" && content !== primary) {
        out.push(content.slice(0, 280));
        out.push(...fileMentions(content));
      } else if (turn.role === "assistant") {
        out.push(...fileMentions(content));
      }
      if (out.length >= 8) break;
    }
    if (looksLikeSyllabusCheck(primary) || /\bsyllab/i.test(primary)) {
      out.push("syllabus", "course outline");
    }
    // Inventory titles that match course codes / syllabus words from the conversation.
    const needles = uniqueStrings([
      ...fileMentions(primary),
      ...priorTurns.flatMap((t) => fileMentions(t.content ?? "")),
    ]).map((n) => n.toLowerCase());
    for (const name of inventoryFileNames(inventory)) {
      const lower = name.toLowerCase();
      if (
        /syllab|outline|policies|expectations|inventory/.test(lower) ||
        needles.some((n) => n.length >= 4 && (lower.includes(n) || n.includes(lower.slice(0, 24))))
      ) {
        out.push(name);
      }
    }
  }

  return uniqueStrings(out).slice(0, 10);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const q = raw.trim().replace(/\s+/g, " ");
    if (!q) continue;
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  return out;
}

function dedupeFiles(files: DriveFile[]): DriveFile[] {
  const seen = new Set<string>();
  const out: DriveFile[] = [];
  for (const file of files) {
    if (seen.has(file.id)) continue;
    seen.add(file.id);
    out.push(file);
  }
  return out;
}

/** Prefer syllabus-like / name-matching files first when loading full text. */
export function rankFilesForTurn(files: DriveFile[], queries: string[]): DriveFile[] {
  const needles = queries.map((q) => q.toLowerCase());
  const score = (file: DriveFile) => {
    const name = file.name.toLowerCase();
    let s = 0;
    if (/syllab|outline|policies|expectations/.test(name)) s += 50;
    if (/inventory|roster|schedule/.test(name)) s += 30;
    for (const n of needles) {
      if (n.length >= 3 && name.includes(n)) s += 20;
      const codeMatch = n.match(/\b[a-z]{2,6}\s?-?\s?\d{3,4}[a-z]?\b/);
      const code = codeMatch?.[0];
      if (code && name.includes(code.replace(/\s+/g, ""))) s += 25;
      if (code && name.includes(code)) s += 25;
    }
    return s;
  };
  return [...files].sort((a, b) => score(b) - score(a));
}

export type TurnDriveSearchDeps = {
  drive: DriveClient;
  accessToken: string;
  cacheStore?: Store;
  userId?: string;
  geminiApiKey?: string | null;
  liteModel?: string;
  fetchImpl?: FetchLike;
};

export type FetchDriveTurnOptions = {
  /** DRIVE INVENTORY text from session context (names/types only). */
  inventory?: string;
};

/**
 * Search Drive for this turn and return FULL file text for the best matches.
 * Empty string only when nothing could be found/read.
 */
export async function fetchDriveExcerptsForTurn(
  deps: TurnDriveSearchDeps,
  utterance: string,
  priorTurns: ReadonlyArray<{ role: string; content: string }> = [],
  options: FetchDriveTurnOptions = {},
): Promise<string> {
  const inventory = options.inventory ?? "";
  const queries = driveSearchQueries(utterance, priorTurns, inventory);
  if (queries.length === 0) return "";

  const hits: DriveFile[] = [];
  for (const q of queries) {
    try {
      const batch = await deps.drive.search(deps.accessToken, q, 10);
      hits.push(...batch);
    } catch {
      /* try the next query */
    }
    if (hits.length >= 24) break;
  }

  const full = wantsFullDriveLoad(utterance);
  const ranked = rankFilesForTurn(dedupeFiles(hits), queries);
  const files = ranked.slice(0, full ? FULL_FILE_COUNT : 6);
  if (files.length === 0) {
    return full
      ? "Drive search for this turn found no matching files to open. Do not claim you checked file contents."
      : "";
  }

  // Full opens always go through Lite depth (local structure + chunk map-reduce).
  // Never dump raw FULL CONTENTS into flash-lite chat.
  if (full) {
    const fileTexts: Array<{ name: string; mimeType: string; text: string }> = [];
    for (const file of files) {
      const result =
        deps.cacheStore && deps.userId
          ? await readFileTextCached(
              deps.drive,
              deps.cacheStore,
              deps.userId,
              deps.accessToken,
              file,
              FULL_FILE_CHARS,
            )
          : await deps.drive.readFileText(deps.accessToken, file, { maxChars: FULL_FILE_CHARS });
      if (result.ok) {
        fileTexts.push({ name: file.name, mimeType: file.mimeType, text: result.text });
      }
    }
    if (fileTexts.length > 0) {
      return prepareLiteDepthContext({
        fileTexts,
        utterance,
        geminiApiKey: deps.geminiApiKey,
        liteModel: deps.liteModel ?? "gemini-3.5-flash-lite",
        fetchImpl: deps.fetchImpl,
      });
    }
    return "Drive files matched but none yielded readable text. Do not invent contents.";
  }

  return summarizeDriveFilesWithExcerpts(
    deps.drive,
    deps.accessToken,
    files,
    `Drive search for this turn (“${queries[0]!.slice(0, 80)}”):`,
    {
      maxExcerptFiles: 4,
      maxCharsPerFile: 8_000,
      maxInventoryChars: 2_000,
      contentLabel: "Content excerpt",
    },
  );
}
