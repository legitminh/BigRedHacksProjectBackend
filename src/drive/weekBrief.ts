/**
 * Deep Drive brief: cache-first full-text load for overview / due / inventory asks.
 * Callers attach the returned block to study context so the model answers from file rows.
 */

import type { FetchLike } from "../http.ts";
import type { Store } from "../store/types.ts";
import { readFileTextCached } from "./cache.ts";
import { prepareLiteDepthContext } from "./liteDepth.ts";
import type { DriveClient, DriveFile } from "./client.ts";
import { INVENTORY_DEFAULT_MAX_FILES } from "./client.ts";
import type { ExtractResult } from "./extract.ts";

export const DEEP_BRIEF_DEFAULT_INVENTORY_MAX = INVENTORY_DEFAULT_MAX_FILES;
export const DEEP_BRIEF_MAX_FILES = 20;
export const DEEP_BRIEF_MAX_CHARS_PER_FILE = 80_000;
export const DEEP_BRIEF_LOAD_CONCURRENCY = 4;

const COURSE_CODE = /\b[A-Z]{2,6}\s?-?\s?\d{3,4}[A-Z]?\b/g;

const DEEP_OVERVIEW =
  /\b(due|prioriti[sz]e|this week|next week|syllab|assignment|homework|hw\b|problem set|ps\d|what(?:'s| is) due|everything due|all due)\b/i;

const DEEP_LIST =
  /\b(list all|full list|every(?:thing)?|all of|inventory|equipment|gear|rundown|breakdown|itemize|itemised|itemized|excluding|exclude|retired)\b/i;

const DEEP_OVERVIEW_SOFT =
  /\b(overview|run down|run-through|go through|check my|confirm|walk me through)\b/i;

const SYLLABUS_NAME = /syllab|outline|policies|expectations|course schedule/i;
const INVENTORY_NAME = /inventory|equipment|gear|roster|asset|stock|checklist/i;

export function isDeepOverviewIntent(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (DEEP_OVERVIEW.test(t)) return true;
  if (DEEP_LIST.test(t)) return true;
  if (DEEP_OVERVIEW_SOFT.test(t) && (DEEP_OVERVIEW.test(t) || SYLLABUS_NAME.test(t) || INVENTORY_NAME.test(t))) {
    return true;
  }
  if (/\b(syllab|assignments?)\b/i.test(t) && /\b(all|every|each|my courses?)\b/i.test(t)) return true;
  return false;
}

/** Gear/list/syllabus exhaustive loads — never satisfied by the daily digest alone. */
export function needsExhaustiveFileLoad(text: string): boolean {
  const lower = text.trim().toLowerCase();
  if (!lower) return false;
  if (
    lower.includes("list all") ||
    lower.includes("all of") ||
    lower.includes("full list") ||
    lower.includes("itemize") ||
    lower.includes("excluding") ||
    lower.includes("exclude") ||
    lower.includes("retired") ||
    lower.includes("percent") ||
    lower.includes("breakdown")
  ) {
    return true;
  }
  if (
    (lower.includes("all") || lower.includes("every")) &&
    (lower.includes("equipment") ||
      lower.includes("gear") ||
      lower.includes("inventory") ||
      lower.includes("assignment") ||
      lower.includes("syllab"))
  ) {
    return true;
  }
  if (lower.includes("inventory") || lower.includes("equipment list")) return true;
  if (lower.includes("climbing") && (lower.includes("gear") || lower.includes("equipment"))) return true;
  return false;
}

/** Due/priority/week asks answered from SCHOOL DIGEST (skip per-turn Drive when digest present). */
export function isDigestCoversTurnIntent(text: string): boolean {
  if (needsExhaustiveFileLoad(text)) return false;
  const lower = text.trim().toLowerCase();
  if (!lower) return false;
  return (
    lower.includes("what's due") ||
    lower.includes("what is due") ||
    lower.includes("prioriti") ||
    lower.includes("this week") ||
    lower.includes("next week") ||
    lower.includes("overview") ||
    lower.includes("big picture") ||
    lower.includes("due date") ||
    lower.includes("deadline") ||
    lower.includes("homework") ||
    lower.includes("assignment") ||
    lower.includes("problem set") ||
    lower.includes("everything due") ||
    lower.includes("all due")
  );
}

export function courseCodesFromText(text: string): string[] {
  if (!text?.trim()) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(COURSE_CODE)) {
    const normalized = normalizeCourseCode(m[0]);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(m[0].replace(/\s+/g, " ").trim());
  }
  return out;
}

function normalizeCourseCode(raw: string): string {
  return raw.replace(/\s+/g, "").replace(/-/g, "").toUpperCase();
}

function courseCodeInFileName(code: string, fileName: string): boolean {
  const normCode = normalizeCourseCode(code);
  const normName = fileName.replace(/\s+/g, "").replace(/-/g, "").toUpperCase();
  if (normName.includes(normCode)) return true;
  const dept = normCode.match(/^([A-Z]{2,6})(\d{3,4}[A-Z]?)$/)?.[1];
  const num = normCode.match(/^([A-Z]{2,6})(\d{3,4}[A-Z]?)$/)?.[2];
  if (dept && num && normName.includes(dept) && normName.includes(num)) return true;
  return false;
}

function topicalTermsFromUtterance(utterance: string): string[] {
  const stop = new Set([
    "the", "and", "for", "with", "that", "this", "what", "when", "where", "which", "about",
    "from", "have", "has", "all", "list", "every", "everything", "excluding", "exclude", "been",
    "that", "been", "retired", "club", "gear", "equipment", "inventory",
  ]);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of utterance.toLowerCase().split(/[^a-z0-9]+/i)) {
    const term = raw.trim();
    if (term.length < 3 || stop.has(term) || seen.has(term)) continue;
    seen.add(term);
    out.push(term);
  }
  return out;
}

function utteranceWantsInventory(utterance: string): boolean {
  return INVENTORY_NAME.test(utterance) || DEEP_LIST.test(utterance);
}

function utteranceWantsSyllabi(utterance: string): boolean {
  return DEEP_OVERVIEW.test(utterance) || SYLLABUS_NAME.test(utterance);
}

function scoreFileForBrief(
  file: DriveFile,
  codes: string[],
  topical: string[],
  wantsInventory: boolean,
  wantsSyllabi: boolean,
): number {
  const name = file.name;
  const lower = name.toLowerCase();
  let s = 0;

  if (wantsSyllabi && SYLLABUS_NAME.test(lower)) s += 40;
  if (wantsInventory && INVENTORY_NAME.test(lower)) s += 40;

  for (const code of codes) {
    if (courseCodeInFileName(code, name)) {
      s += 35;
      if (SYLLABUS_NAME.test(lower)) s += 25;
    }
  }

  for (const term of topical) {
    if (term.length >= 4 && lower.includes(term)) s += 15;
  }

  if (wantsInventory && topical.length > 0) {
    const hits = topical.filter((t) => t.length >= 4 && lower.includes(t)).length;
    if (hits >= 2) s += 20;
  }

  return s;
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

export type SelectFilesForBriefInput = {
  inventoryFiles: DriveFile[];
  calendarSummary: string;
  utterance: string;
  searchHits?: DriveFile[];
};

/**
 * Pick up to DEEP_BRIEF_MAX_FILES syllabus + topical inventory sheets for a deep brief.
 */
export function selectFilesForBrief(input: SelectFilesForBriefInput): DriveFile[] {
  const { inventoryFiles, calendarSummary, utterance, searchHits = [] } = input;
  const codes = uniqueCodes([
    ...courseCodesFromText(calendarSummary),
    ...courseCodesFromText(utterance),
  ]);
  const topical = topicalTermsFromUtterance(utterance);
  const wantsInventory = utteranceWantsInventory(utterance);
  const wantsSyllabi = utteranceWantsSyllabi(utterance) || codes.length > 0;

  const pool = dedupeFiles([...searchHits, ...inventoryFiles]);

  const scored = pool
    .map((file) => ({
      file,
      score: scoreFileForBrief(file, codes, topical, wantsInventory, wantsSyllabi),
    }))
    .filter(({ score, file }) => {
      if (score > 0) return true;
      if (wantsSyllabi && codes.length > 0) {
        return codes.some((c) => courseCodeInFileName(c, file.name)) && SYLLABUS_NAME.test(file.name);
      }
      if (wantsInventory && INVENTORY_NAME.test(file.name)) {
        return topical.some((t) => t.length >= 4 && file.name.toLowerCase().includes(t));
      }
      return false;
    })
    .sort((a, b) => b.score - a.score);

  const selected: DriveFile[] = [];
  const usedIds = new Set<string>();

  const push = (file: DriveFile) => {
    if (usedIds.has(file.id) || selected.length >= DEEP_BRIEF_MAX_FILES) return;
    usedIds.add(file.id);
    selected.push(file);
  };

  if (wantsSyllabi && codes.length > 0) {
    for (const code of codes) {
      const matches = pool.filter(
        (f) => courseCodeInFileName(code, f.name) && SYLLABUS_NAME.test(f.name),
      );
      for (const f of matches) push(f);
    }
  }

  if (wantsInventory) {
    for (const f of pool) {
      if (!INVENTORY_NAME.test(f.name)) continue;
      if (topical.length === 0 || topical.some((t) => t.length >= 4 && f.name.toLowerCase().includes(t))) {
        push(f);
      }
    }
  }

  for (const { file } of scored) push(file);

  return selected.slice(0, DEEP_BRIEF_MAX_FILES);
}

function uniqueCodes(codes: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of codes) {
    const k = normalizeCourseCode(c);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

export type DeepBriefStore = {
  getDriveFileText?(userId: string, fileId: string): Promise<string | null | undefined>;
  setDriveFileText?(userId: string, fileId: string, text: string): Promise<void>;
};

export type BuildDeepBriefTextInput = {
  drive: DriveClient;
  /** Preferred: full Store with modifiedTime-aware cache (F1). */
  cacheStore?: Store;
  /** Legacy thin adapter; ignored when cacheStore is set. */
  store?: DeepBriefStore;
  userId?: string;
  accessToken: string;
  files: DriveFile[];
  utterance: string;
  calendarSummary: string;
  inventoryTruncated?: boolean;
  geminiApiKey?: string | null;
  liteModel?: string;
  fetchImpl?: FetchLike;
};

export type DeepBriefResult = {
  summary: string;
  file_count: number;
  truncated?: boolean;
};

export type BuildDeepBriefDeps = {
  drive: DriveClient;
  accessToken: string;
  cacheStore?: Store;
  store?: DeepBriefStore;
  userId?: string;
  geminiApiKey?: string | null;
  liteModel?: string;
  fetchImpl?: FetchLike;
};

export type BuildDeepBriefOptions = {
  utterance: string;
  calendarSummary: string;
  inventoryFiles: DriveFile[];
  inventoryTruncated?: boolean;
};

async function loadFileText(
  drive: DriveClient,
  accessToken: string,
  file: DriveFile,
  cacheStore: Store | undefined,
  store: DeepBriefStore | undefined,
  userId: string | undefined,
): Promise<ExtractResult> {
  const maxChars = DEEP_BRIEF_MAX_CHARS_PER_FILE;

  if (cacheStore && userId) {
    return readFileTextCached(drive, cacheStore, userId, accessToken, file, maxChars);
  }

  if (store?.getDriveFileText && userId) {
    try {
      const cached = await store.getDriveFileText(userId, file.id);
      if (typeof cached === "string" && cached.length > 0) {
        const text =
          cached.length > maxChars ? `${cached.slice(0, maxChars - 1).trimEnd()}…` : cached;
        return { ok: true, text, kind: "cached" };
      }
    } catch {
      /* fall through to live read */
    }
  }

  const result = await drive.readFileText(accessToken, file, { maxChars });
  if (result.ok && store?.setDriveFileText && userId) {
    try {
      await store.setDriveFileText(userId, file.id, result.text);
    } catch {
      /* ignore cache write failures */
    }
  }
  return result;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

function computeGaps(
  files: DriveFile[],
  loadedIds: Set<string>,
  codes: string[],
  utterance: string,
  loadFailures: string[],
  inventoryTruncated?: boolean,
): string[] {
  const gaps: string[] = [...loadFailures];
  if (inventoryTruncated) {
    gaps.push("Drive inventory listing was truncated; some files may be missing from selection.");
  }
  const loadedNames = files.filter((f) => loadedIds.has(f.id)).map((f) => f.name);

  for (const code of codes) {
    const hasSyllabus = files.some(
      (f) =>
        loadedIds.has(f.id) &&
        courseCodeInFileName(code, f.name) &&
        SYLLABUS_NAME.test(f.name),
    );
    if (!hasSyllabus) {
      gaps.push(`No syllabus/outline loaded for course ${code} (check Drive inventory).`);
    }
  }

  if (utteranceWantsInventory(utterance)) {
    const hasInventory = loadedNames.some((n) => INVENTORY_NAME.test(n));
    if (!hasInventory) {
      gaps.push("No inventory/equipment sheet loaded matching this ask.");
    }
  }

  const notSelected = files.length === 0 ? ["No files were selected for this brief."] : [];
  return [...gaps, ...notSelected];
}

function searchQueriesForDeepBrief(
  utterance: string,
  inventoryFiles: DriveFile[],
  priorTurns: ReadonlyArray<{ role: string; content: string }> = [],
): string[] {
  const primary = utterance.trim().replace(/\s+/g, " ");
  const out: string[] = primary ? [primary] : [];
  for (const turn of [...priorTurns].reverse()) {
    const content = turn.content?.trim().replace(/\s+/g, " ");
    if (!content || content.length < 4 || content === primary) continue;
    if (turn.role === "user") out.push(content.slice(0, 280));
    if (out.length >= 8) break;
  }
  if (utteranceWantsSyllabi(utterance)) {
    out.push("syllabus", "course outline", "assignment due");
  }
  const topical = topicalTermsFromUtterance(utterance);
  for (const file of inventoryFiles) {
    const lower = file.name.toLowerCase();
    if (utteranceWantsSyllabi(utterance) && SYLLABUS_NAME.test(lower)) out.push(file.name);
    if (utteranceWantsInventory(utterance) && INVENTORY_NAME.test(lower)) {
      if (topical.length === 0 || topical.some((t) => t.length >= 4 && lower.includes(t))) {
        out.push(file.name);
      }
    }
  }
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const raw of out) {
    const q = raw.trim();
    if (!q) continue;
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(q);
  }
  return unique.slice(0, 12);
}

export async function collectSearchHits(
  drive: DriveClient,
  accessToken: string,
  utterance: string,
  inventoryFiles: DriveFile[],
  priorTurns: ReadonlyArray<{ role: string; content: string }> = [],
): Promise<DriveFile[]> {
  const searchHits: DriveFile[] = [];
  for (const q of searchQueriesForDeepBrief(utterance, inventoryFiles, priorTurns)) {
    try {
      searchHits.push(...(await drive.search(accessToken, q, 12)));
    } catch {
      /* try next query */
    }
    if (searchHits.length >= 36) break;
  }
  return searchHits;
}

async function formatDeepBriefBlock(input: BuildDeepBriefTextInput): Promise<string> {
  const {
    drive,
    cacheStore,
    store,
    userId,
    accessToken,
    files,
    utterance = "",
    calendarSummary,
    inventoryTruncated,
    geminiApiKey,
    liteModel,
    fetchImpl,
  } = input;
  const codes = uniqueCodes([
    ...courseCodesFromText(calendarSummary),
    ...courseCodesFromText(utterance),
  ]);

  const intentLine = utterance.trim().replace(/\s+/g, " ").slice(0, 500);

  if (files.length === 0) {
    const gaps = computeGaps([], new Set(), codes, utterance, [], inventoryTruncated);
    return [
      "DEEP BRIEF (authoritative file contents — answer in DEPTH from these; do not summarize away items):",
      `INTENT: ${intentLine || "(none)"}`,
      "CALENDAR (window):",
      calendarSummary.trim() || "(no calendar summary provided)",
      "GAPS:",
      gaps.length ? gaps.map((g) => `- ${g}`).join("\n") : "- (none)",
      "INSTRUCTIONS FOR MODEL: For list/inventory/gear asks, MUST enumerate EVERY non-retired row with identifying fields + counts (brand/color/qty style). FORBID 1–2 sentence category summaries — the first inventory reply is already the full itemized list; chat UI and spoken answer both cover it. For due-date asks, list EVERY due date in window per course with source filename. If a file failed to load, say so under GAPS.",
    ].join("\n");
  }

  const loadResults = await mapWithConcurrency(
    files,
    DEEP_BRIEF_LOAD_CONCURRENCY,
    async (file) => ({
      file,
      result: await loadFileText(drive, accessToken, file, cacheStore, store, userId),
    }),
  );

  const loadedIds = new Set<string>();
  const loadFailures: string[] = [];
  const fileTexts: Array<{ name: string; mimeType: string; text: string }> = [];

  for (const { file, result } of loadResults) {
    if (result.ok) {
      loadedIds.add(file.id);
      fileTexts.push({ name: file.name, mimeType: file.mimeType, text: result.text });
    } else {
      loadFailures.push(`${file.name}: ${result.reason}`);
    }
  }

  const gaps = computeGaps(files, loadedIds, codes, utterance, loadFailures, inventoryTruncated);
  const liteModelName = liteModel ?? "gemini-3.5-flash-lite";
  const liteBlock =
    fileTexts.length > 0
      ? await prepareLiteDepthContext({
          fileTexts,
          utterance,
          calendarSummary,
          geminiApiKey,
          liteModel: liteModelName,
          fetchImpl,
        })
      : "";

  const failedSections = loadFailures.map(
    (f) => `FILE: (load failed)\n(FAILED TO LOAD: ${f})`,
  );

  return [
    "DEEP BRIEF (authoritative structured contents — answer in DEPTH from these; do not summarize away items):",
    `INTENT: ${intentLine || "(none)"}`,
    "CALENDAR (window):",
    calendarSummary.trim() || "(no calendar summary provided)",
    liteBlock,
    ...failedSections,
    "GAPS:",
    gaps.length ? gaps.map((g) => `- ${g}`).join("\n") : "- (none)",
    "INSTRUCTIONS FOR MODEL: When STRUCTURED LIST / LITE DEPTH / DEEP BRIEF are present (or inventory/gear/list-all intent), MUST present every row in STRUCTURED LIST and every item in STRUCTURED FACTS / STRUCTURED NOTES with identifying fields + counts. FORBID 1–2 sentence category summaries — first inventory reply is already the full itemized list; chat UI and spoken answer both cover it. If a file failed to load, say so under GAPS.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Load selected files and return the DEEP BRIEF text block only. */
export async function buildDeepBriefText(input: BuildDeepBriefTextInput): Promise<string> {
  return formatDeepBriefBlock(input);
}

/**
 * Either format pre-selected files (`buildDeepBriefText`) or run inventory + search + select
 * when called as `buildDeepBrief(deps, options)` from HTTP.
 */
export async function buildDeepBrief(
  depsOrInput: BuildDeepBriefDeps | BuildDeepBriefTextInput,
  options?: BuildDeepBriefOptions,
): Promise<string | DeepBriefResult> {
  if (options !== undefined) {
    return buildDeepBriefFromInventory(depsOrInput as BuildDeepBriefDeps, options);
  }
  return formatDeepBriefBlock(depsOrInput as BuildDeepBriefTextInput);
}

/**
 * Inventory crawl + Drive search + selectFilesForBrief + {@link formatDeepBriefBlock}.
 */
export async function buildDeepBriefFromInventory(
  deps: BuildDeepBriefDeps,
  options: BuildDeepBriefOptions,
): Promise<DeepBriefResult> {
  const utterance =
    options.utterance.trim() ||
    "what is due this week; prioritize everything from my syllabi and schedules";

  const searchHits = await collectSearchHits(
    deps.drive,
    deps.accessToken,
    utterance,
    options.inventoryFiles,
  );

  const files = selectFilesForBrief({
    inventoryFiles: options.inventoryFiles,
    calendarSummary: options.calendarSummary,
    utterance,
    searchHits,
  });

  const summary = await formatDeepBriefBlock({
    drive: deps.drive,
    cacheStore: deps.cacheStore,
    store: deps.store,
    userId: deps.userId,
    accessToken: deps.accessToken,
    files,
    utterance,
    calendarSummary: options.calendarSummary,
    inventoryTruncated: options.inventoryTruncated,
    geminiApiKey: deps.geminiApiKey,
    liteModel: deps.liteModel,
    fetchImpl: deps.fetchImpl,
  });

  return {
    summary,
    file_count: files.length,
    ...(options.inventoryTruncated ? { truncated: true } : {}),
  };
}

export type RunDeepBriefForQueryInput = {
  utterance: string;
  calendarSummary: string;
  inventoryFiles: DriveFile[];
  inventoryTruncated?: boolean;
  priorTurns?: ReadonlyArray<{ role: string; content: string }>;
};

export type DeepBriefResponse = {
  summary: string;
  file_count: number;
  truncated: boolean;
};

/**
 * Inventory + search + selectFilesForBrief + buildDeepBrief — used by HTTP and Live voice turns.
 */
export async function runDeepBriefForQuery(
  deps: {
    drive: DriveClient;
    accessToken: string;
    cacheStore?: Store;
    store?: DeepBriefStore;
    userId?: string;
  },
  input: RunDeepBriefForQueryInput,
): Promise<DeepBriefResponse> {
  const {
    utterance,
    calendarSummary,
    inventoryFiles,
    inventoryTruncated = false,
    priorTurns = [],
  } = input;

  const searchHits = await collectSearchHits(
    deps.drive,
    deps.accessToken,
    utterance,
    inventoryFiles,
    priorTurns,
  );

  const files = selectFilesForBrief({
    inventoryFiles,
    calendarSummary,
    utterance,
    searchHits,
  });

  const summary = await formatDeepBriefBlock({
    drive: deps.drive,
    accessToken: deps.accessToken,
    cacheStore: deps.cacheStore,
    store: deps.store,
    userId: deps.userId,
    files,
    utterance,
    calendarSummary,
    inventoryTruncated,
    geminiApiKey: deps.geminiApiKey,
    liteModel: deps.liteModel,
    fetchImpl: deps.fetchImpl,
  });

  return { summary, file_count: files.length, truncated: inventoryTruncated };
}
