import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Config } from "../config.ts";
import { HttpError, bearerToken, sendError, sendJson } from "../http.ts";
import type { FetchLike } from "../http.ts";

/** Max body for Ollama generate (text + rare small images). */
export const COACH_BODY_MAX = 4 * 1024 * 1024;

const TAGS_TIMEOUT_MS = 5_000;
const GENERATE_TIMEOUT_MS = 120_000;

export function ollamaConfigured(config: Config): boolean {
  return Boolean(config.ollamaBaseUrl);
}

/** Constant-time compare so COACH_API_TOKEN is not leaked via response timing. */
export function tokensEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

export function coachTokenOk(config: Config, req: IncomingMessage): boolean {
  const token = bearerToken(req);
  if (!token || !config.coachApiToken) return false;
  return tokensEqual(token, config.coachApiToken);
}

export async function readCoachJson(req: IncomingMessage): Promise<unknown> {
  const declared = req.headers["content-length"];
  if (typeof declared === "string") {
    const n = Number.parseInt(declared, 10);
    if (Number.isFinite(n) && n > COACH_BODY_MAX) {
      throw new HttpError(413, "body_too_large", "Coach request body is too large.");
    }
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += buf.length;
    if (size > COACH_BODY_MAX) {
      throw new HttpError(413, "body_too_large", "Coach request body is too large.");
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new HttpError(400, "invalid_json", "Request body is not valid JSON.");
  }
}

function ollamaErrorMessage(baseUrl: string, error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  const cause =
    error instanceof Error && error.cause instanceof Error
      ? error.cause.message
      : error instanceof Error && error.cause && typeof error.cause === "object" && "code" in error.cause
        ? String((error.cause as { code: unknown }).code)
        : "";
  const detail = cause && !msg.includes(cause) ? `${msg} (${cause})` : msg;
  if (/abort|timeout/i.test(detail)) {
    return "Lock-in coach timed out.";
  }
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|EHOSTUNREACH/i.test(detail)) {
    return "Could not reach the lock-in coach.";
  }
  return "Could not reach the lock-in coach.";
}

async function proxyOllama(
  config: Config,
  fetchImpl: FetchLike,
  method: string,
  ollamaPath: string,
  body?: unknown,
  timeoutMs = TAGS_TIMEOUT_MS,
): Promise<{ status: number; json: unknown }> {
  if (!config.ollamaBaseUrl) {
    throw new HttpError(
      503,
      "ollama_not_configured",
      "Lock-in coach is unavailable.",
    );
  }
  const url = `${config.ollamaBaseUrl.replace(/\/+$/, "")}${ollamaPath}`;
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch (e) {
    throw new HttpError(502, "ollama_unreachable", ollamaErrorMessage(config.ollamaBaseUrl, e));
  }
  const text = await res.text();
  let json: unknown = {};
  if (text) {
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = { error: text.slice(0, 500) };
    }
  }
  return { status: res.status, json };
}

/** Treat `name` and `name:latest` as the same Ollama model. */
function canonicalModel(name: string): string {
  const lower = name.trim().toLowerCase();
  return lower.endsWith(":latest") ? lower.slice(0, -":latest".length) : lower;
}

/** Models this API host is willing to run: the three configured ones + OLLAMA_ALLOWED_MODELS. */
export function allowedOllamaModels(config: Config): Set<string> {
  return new Set(
    [config.ollamaModel, config.ollamaVisionModel, config.ollamaChatModel, ...config.ollamaAllowedModels]
      .filter((name) => typeof name === "string" && name.trim().length > 0)
      .map(canonicalModel),
  );
}

/** Upper bounds so a caller cannot pin the GPU with huge contexts / endless generations. */
const MAX_NUM_PREDICT = 4096;

const MAX_GENERATE_IMAGES = 2;
const MAX_IMAGE_B64_CHARS = 2 * 1024 * 1024;

function normalizeGenerateBody(config: Config, body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "invalid_body", "Generate body must be a JSON object.");
  }
  const input = body as Record<string, unknown>;
  const model = input.model;
  if (typeof model !== "string" || model.trim().length === 0) {
    throw new HttpError(400, "model_required", "A model is required.");
  }
  if (!allowedOllamaModels(config).has(canonicalModel(model))) {
    // Do not echo the allowlist back — just say it is not served here.
    throw new HttpError(403, "model_not_allowed", "That model is not available on this server.");
  }
  // Explicit allowlist — do not forward arbitrary client keys (e.g. huge images arrays).
  const out: Record<string, unknown> = {
    model: model.trim(),
    stream: false,
  };
  if (typeof input.prompt === "string") out.prompt = input.prompt;
  if (typeof input.system === "string") out.system = input.system;
  if (typeof input.template === "string") out.template = input.template;
  // Ollama structured output: "json" or a JSON-schema object (plain object only).
  if (typeof input.format === "string") {
    out.format = input.format;
  } else if (
    input.format !== undefined &&
    input.format !== null &&
    typeof input.format === "object" &&
    !Array.isArray(input.format)
  ) {
    out.format = input.format;
  }
  if (typeof input.raw === "boolean") out.raw = input.raw;
  if (typeof input.keep_alive === "string" || typeof input.keep_alive === "number") {
    out.keep_alive = input.keep_alive;
  }
  if (input.images !== undefined) {
    if (!Array.isArray(input.images)) {
      throw new HttpError(400, "invalid_body", "images must be an array of base64 strings.");
    }
    if (input.images.length > MAX_GENERATE_IMAGES) {
      throw new HttpError(400, "invalid_body", `At most ${MAX_GENERATE_IMAGES} images are allowed.`);
    }
    const images: string[] = [];
    for (const img of input.images) {
      if (typeof img !== "string" || !img.trim()) {
        throw new HttpError(400, "invalid_body", "Each image must be a non-empty base64 string.");
      }
      if (img.length > MAX_IMAGE_B64_CHARS) {
        throw new HttpError(400, "invalid_body", "Image payload is too large.");
      }
      images.push(img);
    }
    if (images.length > 0) out.images = images;
  }
  if (input.options !== undefined) {
    if (input.options === null || typeof input.options !== "object" || Array.isArray(input.options)) {
      throw new HttpError(400, "invalid_body", "options must be an object.");
    }
    const options: Record<string, unknown> = { ...(input.options as Record<string, unknown>) };
    if (typeof options.num_ctx === "number" && options.num_ctx > config.ollamaChatNumCtx) {
      options.num_ctx = config.ollamaChatNumCtx;
    }
    if (typeof options.num_predict === "number" && options.num_predict > MAX_NUM_PREDICT) {
      options.num_predict = MAX_NUM_PREDICT;
    }
    out.options = options;
  }
  return out;
}

/** Ollama-compatible surface under /v1/coach so the desktop can set base to …/v1/coach */
export async function handleCoach(
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
  fetchImpl: FetchLike,
  authorize: () => Promise<void>,
): Promise<boolean> {
  if (!path.startsWith("/v1/coach")) return false;

  try {
    await authorize();

    if (method === "GET" && (path === "/v1/coach/api/tags" || path === "/v1/coach/health")) {
      if (path === "/v1/coach/health") {
        if (!ollamaConfigured(config)) {
          sendJson(res, 503, {
            ok: false,
            error: {
              code: "ollama_not_configured",
              message: "Lock-in coach is unavailable.",
            },
          });
          return true;
        }
        try {
          const { status, json } = await proxyOllama(config, fetchImpl, "GET", "/api/tags");
          sendJson(res, status === 200 ? 200 : status, {
            ok: status === 200,
            ollama: json,
          });
        } catch (error) {
          if (error instanceof HttpError && error.code === "ollama_unreachable") {
            sendJson(res, 502, {
              ok: false,
              error: { code: error.code, message: error.message },
            });
            return true;
          }
          throw error;
        }
        return true;
      }
      const { status, json } = await proxyOllama(config, fetchImpl, "GET", "/api/tags");
      sendJson(res, status, json);
      return true;
    }

    if (method === "POST" && path === "/v1/coach/api/generate") {
      const body = normalizeGenerateBody(config, await readCoachJson(req));
      const { status, json } = await proxyOllama(
        config,
        fetchImpl,
        "POST",
        "/api/generate",
        body,
        GENERATE_TIMEOUT_MS,
      );
      sendJson(res, status, json);
      return true;
    }

    if (path === "/v1/coach/api/tags" || path === "/v1/coach/api/generate" || path === "/v1/coach/health") {
      throw new HttpError(405, "method_not_allowed", "Method not allowed.");
    }
    throw new HttpError(404, "not_found", "No coach route for that path.");
  } catch (error) {
    if (!res.headersSent) sendError(res, error);
    return true;
  }
}
