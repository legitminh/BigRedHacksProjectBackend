import type { IncomingMessage, ServerResponse } from "node:http";

import type { Config } from "../config.ts";
import type { FetchLike } from "../http.ts";
import { HttpError, readJson, sendError, sendJson } from "../http.ts";
import { rejectImagePayload } from "../product/model.ts";

const IMAGINE_URL = "https://api.x.ai/v1/images/generations";
const IMAGINE_MODEL = "grok-imagine-image-2.0";
const MARKDOWN_MAX = 8_000;
const IMAGINE_TIMEOUT_MS = 60_000;

const BRAG_SHEET_INSTRUCTION = `Create one polished, shareable space-mission brag sheet poster from these session stats.
Layout: a proud statistics achievement card — NOT a flowchart, NOT a concept map, no nodes, no arrows, no mind-map, no tree, no org chart.
Primary brag (when minutes are provided): "Locked in for N minutes" as the hero number.
Include the mission / goal title prominently.
If a concrete accomplishment is listed (finished milestone, completed discussion post, shipped something), feature it as a proud brag line.
Optional light stats (on-task percent, etc.) only when provided — never invent numbers, achievements, or study details.
Tone: celebratory, rocket / mission / cosmos vibe — make a student proud to share. Cosmic gradient or deep-space aesthetic is welcome; keep typography high-contrast and readable.
NEVER render empty diglog placeholders or uncaptured-section filler text. NEVER invent empty diglog sections (What I worked on / Decisions / Stuck on / Next).
No photographs, no people, no faces, no logos, no UI screenshots, no watermarks.`;

export type ConceptMapImage = {
  content_type: string;
  image_base64: string;
};

/** Optional lock-in stats from the desktop (prefer these over inventing from diglog). */
export type BragSheetStats = {
  locked_in_minutes?: number;
  mission?: string;
  on_task_percent?: number;
};

/** Drop a leaked Copilot suggestion block so it is not drawn into the summary. */
export function stripStudySuggest(markdown: string): string {
  return markdown
    .replace(/<<<STUDY_SUGGEST>>>[\s\S]*?<<<END_STUDY_SUGGEST>>>/g, "")
    .replace(/<<<STUDY_SUGGEST>>>[\s\S]*$/g, "")
    .trim();
}

export function extractMissionTitle(markdown: string): string {
  for (const line of markdown.split("\n")) {
    const heading = line.trim().match(/^#\s+(.+)$/);
    if (heading?.[1]?.trim()) return heading[1].trim();
  }
  return "";
}

/** True when the note body has real diglog content beyond "Not captured." placeholders. */
export function noteHasMapTopics(markdown: string): boolean {
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const body = trimmed.replace(/^[-*]\s+/, "").trim().replace(/\.$/, "");
    if (!body) continue;
    if (/^not captured$/i.test(body)) continue;
    return true;
  }
  return false;
}

/** Non-empty diglog lines (section label + body), skipping Not-captured placeholders. */
export function diglogHighlights(markdown: string): string[] {
  const out: string[] = [];
  let section = "";
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const h2 = trimmed.match(/^##\s+(.+)$/);
    if (h2?.[1]) {
      section = h2[1].trim();
      continue;
    }
    if (trimmed.startsWith("#")) continue;
    const body = trimmed.replace(/^[-*]\s+/, "").trim();
    if (!body || /^not captured\.?$/i.test(body)) continue;
    out.push(section ? `${section}: ${body}` : body);
  }
  return out;
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const n = Math.round(value);
  return n > 0 ? n : undefined;
}

function percentInt(value: unknown): number | undefined {
  const n = positiveInt(value);
  if (n === undefined) return undefined;
  return Math.min(100, n);
}

/** Shareable when we have mission, locked-in minutes, or real diglog — not only Not-captured lines. */
export function canBuildBragSheet(markdown: string, stats: BragSheetStats = {}): boolean {
  const cleaned = stripStudySuggest(markdown);
  const mission = (stats.mission?.trim() || extractMissionTitle(cleaned)).trim();
  const minutes = positiveInt(stats.locked_in_minutes) ?? 0;
  if (mission || minutes > 0) return true;
  return diglogHighlights(cleaned).length > 0;
}

/** Build the stats block sent to Imagine — omits empty diglog / Not captured entirely. */
export function buildBragSheetPayload(markdown: string, stats: BragSheetStats = {}): string {
  const cleaned = stripStudySuggest(markdown);
  if (!canBuildBragSheet(cleaned, stats)) {
    if (!cleaned) {
      throw new HttpError(400, "invalid_concept_map", "markdown is required.");
    }
    throw new HttpError(
      400,
      "empty_concept_map",
      "Nothing to brag about yet — need locked-in time or a mission goal.",
    );
  }

  const mission = (stats.mission?.trim() || extractMissionTitle(cleaned)).trim();
  const minutes = positiveInt(stats.locked_in_minutes);
  const onTask = percentInt(stats.on_task_percent);
  const highlights = diglogHighlights(cleaned);

  const lines: string[] = ["BRAG SHEET STATS:"];
  if (minutes !== undefined) {
    lines.push(`- Locked in: ${minutes} minutes`);
  }
  if (mission) {
    lines.push(`- Mission: ${mission}`);
  }
  if (onTask !== undefined) {
    lines.push(`- On-task: ${onTask}%`);
  }
  if (highlights.length) {
    lines.push("- Highlights (only include if they sound like real progress; do not invent):");
    for (const h of highlights.slice(0, 8)) {
      lines.push(`  - ${h}`);
    }
  } else {
    lines.push(
      "- No diglog highlights — celebrate locked-in time + mission only. Do not invent work details.",
    );
  }

  let payload = lines.join("\n");
  if (payload.length > MARKDOWN_MAX) {
    payload = payload.slice(0, MARKDOWN_MAX);
  }
  return payload;
}

/** @deprecated Prefer buildBragSheetPayload — kept for callers that only have markdown. */
export function conceptMapSource(markdown: string, stats: BragSheetStats = {}): string {
  return buildBragSheetPayload(markdown, stats);
}

export function buildConceptMapPrompt(markdown: string, stats: BragSheetStats = {}): string {
  return `${BRAG_SHEET_INSTRUCTION}\n\n${buildBragSheetPayload(markdown, stats)}`;
}

export function parseBragSheetStats(record: Record<string, unknown>): BragSheetStats {
  const mission =
    typeof record.mission === "string" && record.mission.trim() ? record.mission.trim() : undefined;
  return {
    locked_in_minutes: positiveInt(record.locked_in_minutes),
    mission,
    on_task_percent: percentInt(record.on_task_percent),
  };
}

export function parseConceptMapBody(body: unknown): { markdown: string; stats: BragSheetStats } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "invalid_concept_map", "Expected a JSON object.");
  }
  rejectImagePayload(body);
  const record = body as Record<string, unknown>;
  if (typeof record.markdown !== "string") {
    throw new HttpError(400, "invalid_concept_map", "markdown is required.");
  }
  const stats = parseBragSheetStats(record);
  // Validate shareable content up front (throws empty/invalid).
  buildBragSheetPayload(record.markdown, stats);
  return { markdown: record.markdown, stats };
}

export function imageContentType(base64: string): string {
  if (base64.startsWith("iVBORw0KGgo")) return "image/png";
  if (base64.startsWith("/9j/")) return "image/jpeg";
  if (base64.startsWith("UklGR")) return "image/webp";
  return "image/jpeg";
}

export function parseImagineResponse(body: unknown): ConceptMapImage {
  if (!body || typeof body !== "object") {
    throw new HttpError(502, "imagine_empty", "Grok Imagine returned no image.");
  }
  const data = (body as { data?: unknown }).data;
  const first = Array.isArray(data) ? data[0] : null;
  const raw =
    first && typeof first === "object" && typeof (first as { b64_json?: unknown }).b64_json === "string"
      ? (first as { b64_json: string }).b64_json
      : "";
  const base64 = raw.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "").replace(/\s+/g, "");
  if (base64.length < 32) {
    throw new HttpError(502, "imagine_empty", "Grok Imagine returned no image.");
  }
  return { content_type: imageContentType(base64), image_base64: base64 };
}

export async function generateConceptMap(input: {
  config: Config;
  markdown: string;
  stats?: BragSheetStats;
  fetchImpl: FetchLike;
}): Promise<ConceptMapImage> {
  if (!input.config.xaiApiKey) {
    throw new HttpError(
      503,
      "imagine_not_configured",
      "Brag sheets need Grok Imagine on the API (set XAI_API_KEY).",
    );
  }
  const prompt = buildConceptMapPrompt(input.markdown, input.stats ?? {});
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGINE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await input.fetchImpl(IMAGINE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.config.xaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: IMAGINE_MODEL,
        prompt,
        n: 1,
        aspect_ratio: "16:9",
        resolution: "1k",
        quality: "low",
        response_format: "b64_json",
      }),
      signal: controller.signal,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/abort/i.test(msg)) {
      throw new HttpError(504, "imagine_timeout", "Grok Imagine timed out.");
    }
    throw new HttpError(502, "imagine_unreachable", "Could not reach Grok Imagine.");
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const snippet = detail.trim().slice(0, 240);
    if (response.status === 401 || response.status === 403) {
      throw new HttpError(502, "imagine_auth", "xAI rejected the API key for Imagine.");
    }
    if (response.status === 429) {
      throw new HttpError(429, "imagine_quota", "Grok Imagine rate limit hit.");
    }
    throw new HttpError(
      502,
      "imagine_failed",
      snippet ? `Grok Imagine failed: ${snippet}` : `Grok Imagine failed (HTTP ${response.status}).`,
    );
  }

  const payload = (await response.json()) as unknown;
  return parseImagineResponse(payload);
}

/** Signed-in mission brag-sheet image for the lock-in final review (`POST /v1/concept-map`). */
export async function handleConceptMap(
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
  fetchImpl: FetchLike,
  authorize: () => Promise<void>,
): Promise<boolean> {
  if (path !== "/v1/concept-map") return false;
  try {
    if (method !== "POST") {
      throw new HttpError(405, "method_not_allowed", "Method not allowed.");
    }
    await authorize();
    const { markdown, stats } = parseConceptMapBody(await readJson(req, 48 * 1024));
    const image = await generateConceptMap({ config, markdown, stats, fetchImpl });
    sendJson(res, 200, image);
    return true;
  } catch (error) {
    if (!res.headersSent) sendError(res, error);
    return true;
  }
}
