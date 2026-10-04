/**
 * On-demand “deep” Drive context using Flash-Lite only.
 *
 * Creative breakdown so Lite can still cover an entire file without Flash:
 * 1) Local tabular / inventory parse → STRUCTURED LIST (no LLM).
 * 2) Local skeleton: split prose on headings / page breaks.
 * 3) Overlapping chunk map-reduce with Lite → dense JSON notes per chunk.
 * 4) Merge + dedupe → STRUCTURED NOTES (+ date-tagged STRUCTURED FACTS).
 *
 * Never uses geminiOverviewModel. Never dumps raw 80k-char FULL CONTENTS
 * into the chat model.
 */

import type { FetchLike } from "../gemini/ephemeral.ts";
import { geminiChat } from "../gemini/chat.ts";

/** Soft cap per Lite map call — leaves room for system + JSON reply. */
export const LITE_DEPTH_CHUNK_CHARS = 4_200;
/** Overlap so dates/sentences straddling a cut are seen twice. */
export const LITE_DEPTH_CHUNK_OVERLAP = 450;
export const LITE_DEPTH_CHUNK_CONCURRENCY = 3;
export const LITE_DEPTH_FILE_CONCURRENCY = 2;
/** Max notes kept from a single chunk after parse. */
export const LITE_DEPTH_MAX_NOTES_PER_CHUNK = 18;

export type LiteDepthFile = {
  name: string;
  mimeType: string;
  text: string;
};

export type PrepareLiteDepthInput = {
  fileTexts: LiteDepthFile[];
  utterance: string;
  calendarSummary?: string;
  geminiApiKey?: string | null;
  liteModel: string;
  fetchImpl?: FetchLike;
};

const INVENTORY_NAME = /inventory|equipment|gear|roster|asset|stock|checklist/i;

function utteranceExcludesRetired(utterance: string): boolean {
  const t = utterance.trim();
  if (!t) return false;
  return (
    /\b(exclud(?:e|ing)|without|omit|skip)\b[\w\s]{0,40}\b(retired|inactive)\b/i.test(t) ||
    /\b(retired|inactive)\b[\w\s]{0,24}\b(exclud|not include|omit)/i.test(t)
  );
}

/** Detect delimiter and parse a delimited table; null if not tabular enough. */
export function parseDelimitedTable(text: string): { headers: string[]; rows: string[][] } | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) return null;

  const candidates = ["\t", ",", "|", ";"];
  let best: { delim: string; cols: number; score: number } | null = null;
  for (const delim of candidates) {
    const counts = lines.slice(0, Math.min(12, lines.length)).map((l) => l.split(delim).length);
    const mode = counts.sort((a, b) => a - b)[Math.floor(counts.length / 2)] ?? 0;
    if (mode < 2) continue;
    const consistent = counts.filter((c) => c === mode).length / counts.length;
    const score = consistent * mode;
    if (!best || score > best.score) best = { delim, cols: mode, score };
  }
  if (!best || best.score < 1.2) return null;

  const split = (line: string) => {
    const parts = line.split(best!.delim).map((c) => c.trim().replace(/^["']|["']$/g, ""));
    while (parts.length < best!.cols) parts.push("");
    return parts.slice(0, best!.cols);
  };

  const headers = split(lines[0]!);
  const rows = lines.slice(1).map(split).filter((r) => r.some((c) => c.length > 0));
  if (rows.length === 0) return null;
  return { headers, rows };
}

export function filterTableRows(
  headers: string[],
  rows: string[][],
  utterance: string,
): string[][] {
  if (!utteranceExcludesRetired(utterance)) return rows;
  const statusIdx = headers.findIndex((h) => /status|state|active|condition/i.test(h));
  if (statusIdx < 0) {
    return rows.filter((row) => {
      const joined = row.join(" ").toLowerCase();
      return !/\bretired\b/.test(joined) && !/\binactive\b/.test(joined);
    });
  }
  return rows.filter((row) => {
    const cell = (row[statusIdx] ?? "").toLowerCase();
    return !/\bretired\b/.test(cell) && !/\binactive\b/.test(cell);
  });
}

export function formatStructuredList(
  fileName: string,
  headers: string[],
  rows: string[][],
): string {
  const lines: string[] = [];
  for (const row of rows) {
    if (headers.length > 0) {
      const pairs = headers.map((h, i) => `${h}: ${row[i] ?? ""}`.trim()).filter(Boolean);
      lines.push(`- ${pairs.join(" | ")}`);
    } else {
      lines.push(`- ${row.join(" | ")}`);
    }
  }
  return [
    `FILE: ${fileName}`,
    `STRUCTURED LIST (complete, ${rows.length} items):`,
    ...lines,
  ].join("\n");
}

function isInventoryFile(name: string, utterance: string): boolean {
  return INVENTORY_NAME.test(name) || INVENTORY_NAME.test(utterance);
}

const HEADING_LINE =
  /^(?:#{1,6}\s+.+|[A-Z][A-Z0-9 /&:,-]{8,80}|Page\s+\d+\b.*|\d{1,2}[.)]\s+[A-Z].{3,80}|Part\s+[IVXLC\d]+[:.].{0,80}|Unit\s+\d+[:.].{0,80}|Week\s+\d+\s*[:.-]\s*[A-Za-z].{0,80}|Section\s+[A-Z0-9]+[:.].{0,80})$/;

/** Lines that look like headings but are themselves facts (due dates, etc.). */
const CONTENTFUL_HEADING =
  /\b(due|deadline|assignment|homework|hw\b|prelim|midterm|final exam|exam\b|quiz|lab report|problem set|ps\d|weight|%|percent)\b/i;

function looksLikeHeading(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 100) return false;
  if (!HEADING_LINE.test(t)) return false;
  // Keep "Week 2: Lab report due Friday" as body text, not an empty section title.
  if (CONTENTFUL_HEADING.test(t)) return false;
  return true;
}

export type TextSection = { title: string; body: string };

/** Split prose into titled sections using local heading heuristics (no LLM). */
export function splitIntoSections(text: string): TextSection[] {
  const lines = text.split(/\r?\n/);
  const sections: TextSection[] = [];
  let title = "(intro)";
  let buf: string[] = [];
  const flush = () => {
    const body = buf.join("\n").trim();
    if (body) sections.push({ title, body });
    buf = [];
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && looksLikeHeading(trimmed) && buf.length > 0) {
      flush();
      title = trimmed.replace(/^#+\s*/, "").slice(0, 120);
      continue;
    }
    if (trimmed && looksLikeHeading(trimmed) && buf.length === 0) {
      title = trimmed.replace(/^#+\s*/, "").slice(0, 120);
      continue;
    }
    buf.push(line);
  }
  flush();
  return sections.length > 0 ? sections : [{ title: "(document)", body: text.trim() }];
}

/** Fixed-size chunks with overlap so boundary facts are not lost. */
export function chunkWithOverlap(
  text: string,
  size: number = LITE_DEPTH_CHUNK_CHARS,
  overlap: number = LITE_DEPTH_CHUNK_OVERLAP,
): string[] {
  const t = text.trim();
  if (!t) return [];
  if (t.length <= size) return [t];
  const step = Math.max(200, size - overlap);
  const chunks: string[] = [];
  for (let i = 0; i < t.length; i += step) {
    const slice = t.slice(i, i + size);
    if (slice.trim()) chunks.push(slice);
    if (i + size >= t.length) break;
  }
  return chunks;
}

/**
 * Prefer section-aware packing: keep whole sections when they fit; otherwise
 * overlap-chunk a long section. Caps total chunks so Lite RPD stays sane.
 */
export function planLiteChunks(text: string, maxChunks = 24): Array<{ title: string; body: string }> {
  const sections = splitIntoSections(text);
  const out: Array<{ title: string; body: string }> = [];
  for (const sec of sections) {
    if (sec.body.length <= LITE_DEPTH_CHUNK_CHARS) {
      out.push(sec);
    } else {
      const parts = chunkWithOverlap(sec.body);
      for (let i = 0; i < parts.length; i++) {
        out.push({
          title: `${sec.title} [part ${i + 1}/${parts.length}]`,
          body: parts[i]!,
        });
      }
    }
    if (out.length >= maxChunks) break;
  }
  if (out.length > maxChunks) return out.slice(0, maxChunks);
  // If skeleton found almost nothing useful, fall back to plain overlap chunks.
  if (out.length <= 1 && text.length > LITE_DEPTH_CHUNK_CHARS) {
    return chunkWithOverlap(text).slice(0, maxChunks).map((body, i, arr) => ({
      title: `part ${i + 1}/${arr.length}`,
      body,
    }));
  }
  return out;
}

type ExtractedNote = {
  kind: string;
  label: string;
  date?: string;
  course?: string;
  section?: string;
};

function parseNotesJson(raw: string): ExtractedNote[] {
  const trimmed = raw.trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!jsonMatch) return [];
  try {
    const parsed = JSON.parse(jsonMatch[0]) as unknown;
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object"
        ? Array.isArray((parsed as { notes?: unknown }).notes)
          ? (parsed as { notes: unknown[] }).notes
          : Array.isArray((parsed as { facts?: unknown }).facts)
            ? (parsed as { facts: unknown[] }).facts
            : []
        : [];
    const out: ExtractedNote[] = [];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const label = typeof rec.label === "string" ? rec.label.trim() : "";
      if (!label) continue;
      out.push({
        kind: typeof rec.kind === "string" ? rec.kind : "note",
        label,
        date: typeof rec.date === "string" ? rec.date : undefined,
        course: typeof rec.course === "string" ? rec.course : undefined,
        section: typeof rec.section === "string" ? rec.section : undefined,
      });
    }
    return out.slice(0, LITE_DEPTH_MAX_NOTES_PER_CHUNK);
  } catch {
    return [];
  }
}

function dedupeNotes(notes: ExtractedNote[]): ExtractedNote[] {
  const seen = new Set<string>();
  const out: ExtractedNote[] = [];
  for (const n of notes) {
    const key = `${n.kind}|${n.date ?? ""}|${n.label}`.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

function heuristicNotesFromText(text: string, section: string): ExtractedNote[] {
  const notes: ExtractedNote[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t.length < 8 || t.length > 280) continue;
    if (
      /\b(due|deadline|assignment|homework|hw\b|prelim|midterm|final|exam|quiz|lab report|problem set|ps\d|weight|grading|office hours|required|textbook|policy|late work|attendance|contact|email|%|percent)\b/i.test(
        t,
      )
    ) {
      notes.push({ kind: "line", label: t, section });
    }
  }
  return dedupeNotes(notes);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length || 1) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function extractNotesFromChunk(
  chunk: { title: string; body: string },
  fileName: string,
  chunkIndex: number,
  chunkTotal: number,
  input: Pick<PrepareLiteDepthInput, "geminiApiKey" | "liteModel" | "fetchImpl" | "utterance">,
): Promise<ExtractedNote[]> {
  if (!input.geminiApiKey?.trim()) {
    return heuristicNotesFromText(chunk.body, chunk.title);
  }
  const prompt = [
    `You are a careful note-taker for ONE small slice of a school document.`,
    `File: "${fileName}" · section: "${chunk.title}" · slice ${chunkIndex + 1}/${chunkTotal}.`,
    `Student ask (context only): ${input.utterance.slice(0, 220)}`,
    "Cover THIS slice completely. Prefer short bullets that preserve exact dates, numbers, names, and requirements.",
    "Include: due dates, exams, grading weights, policies, office hours, topics/units, materials, contacts, and any other concrete fact.",
    "Do not invent. Do not summarize the whole file — only this slice.",
    'Return ONLY JSON: {"notes":[{"kind":"due|exam|grading|policy|topic|contact|other","label":"...","date":"YYYY-MM-DD or free text or empty","course":"optional","section":"optional"}]}',
    "--- SLICE ---",
    chunk.body,
  ].join("\n");
  try {
    const raw = await geminiChat({
      apiKey: input.geminiApiKey,
      model: input.liteModel,
      system: "You output JSON only. Dense, complete coverage of the given slice.",
      history: [],
      message: prompt,
      fetchImpl: input.fetchImpl ?? globalThis.fetch.bind(globalThis),
    });
    const parsed = parseNotesJson(raw).map((n) => ({
      ...n,
      section: n.section || chunk.title,
    }));
    if (parsed.length > 0) return parsed;
  } catch {
    /* fallback */
  }
  return heuristicNotesFromText(chunk.body, chunk.title);
}

function formatStructuredNotes(fileName: string, notes: ExtractedNote[]): string {
  const dated = notes.filter((n) => n.date || /due|exam|prelim|midterm|final|deadline/i.test(n.kind + n.label));
  const other = notes.filter((n) => !dated.includes(n));
  const fmt = (n: ExtractedNote) => {
    const parts = [n.label];
    if (n.date) parts.push(`date: ${n.date}`);
    if (n.course) parts.push(`course: ${n.course}`);
    if (n.section && n.section !== "(intro)" && n.section !== "(document)") {
      parts.push(`section: ${n.section}`);
    }
    return `- ${parts.join(" — ")}`;
  };
  const blocks: string[] = [`FILE: ${fileName}`];
  if (dated.length > 0) {
    blocks.push(`STRUCTURED FACTS (complete, ${dated.length} items):`, ...dated.map(fmt));
  }
  if (other.length > 0 || dated.length === 0) {
    const pool = other.length > 0 ? other : notes;
    blocks.push(`STRUCTURED NOTES (complete, ${pool.length} items):`, ...pool.map(fmt));
  }
  return blocks.join("\n");
}

async function processFile(
  file: LiteDepthFile,
  input: PrepareLiteDepthInput,
): Promise<string> {
  const text = file.text.trim();
  if (!text) {
    return `FILE: ${file.name}\n(FAILED TO LOAD: empty)`;
  }

  const table = parseDelimitedTable(text);
  if (table) {
    const rows = filterTableRows(table.headers, table.rows, input.utterance);
    return formatStructuredList(file.name, table.headers, rows);
  }

  if (isInventoryFile(file.name, input.utterance)) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const items = lines.filter((l) => l.length > 2);
    const filtered = utteranceExcludesRetired(input.utterance)
      ? items.filter((l) => !/\bretired\b/i.test(l) && !/\binactive\b/i.test(l))
      : items;
    return [
      `FILE: ${file.name}`,
      `STRUCTURED LIST (complete, ${filtered.length} items):`,
      ...filtered.map((l) => `- ${l}`),
    ].join("\n");
  }

  const chunks = planLiteChunks(text).map((c) => ({
    title: c.title,
    // Include the section title in the slice so Lite/heuristics never lose heading-only facts.
    body:
      c.title && c.title !== "(intro)" && c.title !== "(document)" && !c.body.startsWith(c.title)
        ? `${c.title}\n${c.body}`
        : c.body,
  }));
  const skeleton = [
    `FILE: ${file.name}`,
    `LOCAL OUTLINE (${chunks.length} slices for Flash-Lite map-reduce):`,
    ...chunks.map((c, i) => `- [${i + 1}] ${c.title} (${c.body.length} chars)`),
  ].join("\n");

  const chunkNotes = await mapWithConcurrency(chunks, LITE_DEPTH_CHUNK_CONCURRENCY, (chunk, i) =>
    extractNotesFromChunk(chunk, file.name, i, chunks.length, input),
  );
  const merged = dedupeNotes(chunkNotes.flat());
  if (merged.length === 0) {
    const fallback = heuristicNotesFromText(text, "(document)");
    if (fallback.length > 0) {
      return `${skeleton}\n\n${formatStructuredNotes(file.name, fallback)}`;
    }
    return [
      skeleton,
      `FILE: ${file.name}`,
      "STRUCTURED NOTES (complete, 0 items):",
      "- (no concrete facts detected in loaded text)",
    ].join("\n");
  }
  return `${skeleton}\n\n${formatStructuredNotes(file.name, merged)}`;
}

/**
 * Build Flash-Lite-friendly structured blocks for on-demand deep reads.
 * Safe to feed into gemini-3.5-flash-lite chat — never raw full-file dumps.
 */
export async function prepareLiteDepthContext(input: PrepareLiteDepthInput): Promise<string> {
  const sections = await mapWithConcurrency(
    input.fileTexts,
    LITE_DEPTH_FILE_CONCURRENCY,
    (file) => processFile(file, input),
  );
  const header = [
    "LITE DEPTH (pre-computed via local structure + Flash-Lite chunk map-reduce — present every row/note/fact below; do not collapse to categories or omit items):",
    input.calendarSummary?.trim()
      ? `CALENDAR (reference):\n${input.calendarSummary.trim()}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return `${header}\n\n${sections.join("\n\n")}`;
}
