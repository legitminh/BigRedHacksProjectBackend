import type { IncomingMessage, ServerResponse } from "node:http";

import type { Config } from "../config.ts";
import type { FetchLike } from "../http.ts";
import { HttpError, readJson, sendError, sendJson } from "../http.ts";
import { rejectImagePayload } from "../product/model.ts";

const IMAGINE_URL = "https://api.x.ai/v1/images/generations";
const IMAGINE_MODEL = "grok-imagine-image-2.0";
const MARKDOWN_MAX = 8_000;
const IMAGINE_TIMEOUT_MS = 60_000;

const SESSION_SUMMARY_INSTRUCTION = `Create one polished, shareable study-session summary graphic from this note.
Layout: a clean social-ready summary card — NOT a flowchart, NOT a concept map, no nodes, no arrows, no mind-map.
Include only content that appears in the note:
- Session title / goal (from the note heading when present)
- What was worked on
- Key takeaways, decisions, gaps / stuck points, or next steps when those sections have real content
If a section says "Not captured.", omit that section entirely. Do not invent topics, takeaways, or next steps.
Style: readable typography, light background, generous margins, high-contrast text, subtle study aesthetic.
No photographs, no people, no faces, no logos, no UI screenshots, no watermarks.`;

export type ConceptMapImage = {
  content_type: string;
  image_base64: string;
};

/** Drop a leaked Copilot suggestion block so it is not drawn into the summary. */
export function stripStudySuggest(markdown: string): string {
  return markdown
    .replace(/<<<STUDY_SUGGEST>>>[\s\S]*?<<<END_STUDY_SUGGEST>>>/g, "")
    .replace(/<<<STUDY_SUGGEST>>>[\s\S]*$/g, "")
    .trim();
}

/** True when the note has content beyond a title and "Not captured." placeholders. */
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

export function conceptMapSource(markdown: string): string {
  const cleaned = stripStudySuggest(markdown);
  if (!cleaned) {
    throw new HttpError(400, "invalid_concept_map", "markdown is required.");
  }
  if (!noteHasMapTopics(cleaned)) {
    throw new HttpError(
      400,
      "empty_concept_map",
      "This note has no captured content to summarize — every section is empty.",
    );
  }
  return cleaned.length > MARKDOWN_MAX ? cleaned.slice(0, MARKDOWN_MAX) : cleaned;
}

export function buildConceptMapPrompt(markdown: string): string {
  return `${SESSION_SUMMARY_INSTRUCTION}\n\nNOTE:\n${conceptMapSource(markdown)}`;
}

export function parseConceptMapBody(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "invalid_concept_map", "Expected a JSON object.");
  }
  rejectImagePayload(body);
  const record = body as Record<string, unknown>;
  if (typeof record.markdown !== "string") {
    throw new HttpError(400, "invalid_concept_map", "markdown is required.");
  }
  return conceptMapSource(record.markdown);
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
  fetchImpl: FetchLike;
}): Promise<ConceptMapImage> {
  if (!input.config.xaiApiKey) {
    throw new HttpError(
      503,
      "imagine_not_configured",
      "Session summaries need Grok Imagine on the API (set XAI_API_KEY).",
    );
  }
  const prompt = buildConceptMapPrompt(input.markdown);
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

/** Signed-in session-summary image for the lock-in final review (`POST /v1/concept-map`). */
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
    const markdown = parseConceptMapBody(await readJson(req, 48 * 1024));
    const image = await generateConceptMap({ config, markdown, fetchImpl });
    sendJson(res, 200, image);
    return true;
  } catch (error) {
    if (!res.headersSent) sendError(res, error);
    return true;
  }
}
