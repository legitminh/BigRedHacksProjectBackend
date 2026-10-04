import { isIP } from "node:net";

import type { PresageVitals } from "./types.ts";

const BASE = "https://api.physiology.presagetech.com";
const PART_CHUNK = 5 * 1024 * 1024;
const DEFAULT_RETRIEVE_TIMEOUT_SEC = 60;

/** Baevsky / Presage stress_index above this → vitals.stressed. */
export const STRESS_INDEX_STRESSED_MIN = 150;
/** RMSSD/HRV below this (ms) → vitals.stressed (VIDEOINPUT-aligned). */
export const HRV_STRESSED_MAX = 20;

/** Host suffixes allowed for multipart PUT after /v2/upload-url (SSRF seatbelt). */
const UPLOAD_HOST_SUFFIXES = [
  ".amazonaws.com",
  ".presagetech.com",
  ".presage.tech",
  ".cloudfront.net",
];

/** Keys that must never fuzzy-match vital tokens (e.g. `"error".includes("rr")`). */
const VITAL_KEY_DENY = new Set([
  "error",
  "error_code",
  "errors",
  "status",
  "current",
  "code",
  "message",
  "detail",
  "details",
  "offset",
  "count",
  "total",
  "length",
  "size",
  "id",
  "index",
]);

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type PresageOptions = {
  fetchImpl?: FetchLike;
  /** Injected in tests so retrieve polling does not wait wall-clock seconds. */
  sleep?: (ms: number) => Promise<void>;
};

function resolveApiKey(apiKey: string | null | undefined): string {
  const fromArg = typeof apiKey === "string" ? apiKey.trim() : "";
  if (fromArg) return fromArg;
  const fromEnv = process.env.PRESAGE_API_KEY?.trim() ?? "";
  if (fromEnv) return fromEnv;
  throw new Error("PRESAGE_API_KEY is not set");
}

function asBytes(videoBytes: Buffer | Uint8Array): Uint8Array {
  if (videoBytes instanceof Uint8Array) return videoBytes;
  throw new Error("videoBytes must be a Buffer or Uint8Array");
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function jsonHeaders(apiKey: string): HeadersInit {
  return {
    "x-api-key": apiKey,
    "Content-Type": "application/json",
  };
}

function isPrivateOrLocalIp(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0") {
    return true;
  }
  const version = isIP(host);
  if (version === 4) {
    const parts = host.split(".").map((p) => Number(p));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return true;
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (version === 6) {
    if (host === "::1" || host === "::") return true;
    if (host.startsWith("fc") || host.startsWith("fd")) return true; // ULA
    if (host.startsWith("fe80")) return true; // link-local
    return false;
  }
  return false;
}

/**
 * Reject SSRF-shaped upload URLs. Presage returns HTTPS S3/CloudFront-style hosts;
 * never follow redirects on PUT.
 */
export function assertSafePresageUploadUrl(urlString: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error("bad upload url");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("upload url must be https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("upload url must not include credentials");
  }
  const host = parsed.hostname.toLowerCase();
  if (!host || isPrivateOrLocalIp(host)) {
    throw new Error("upload url host not allowed");
  }
  const ok = UPLOAD_HOST_SUFFIXES.some(
    (suffix) => host === suffix.slice(1) || host.endsWith(suffix),
  );
  if (!ok) {
    throw new Error("upload url host not allowlisted");
  }
  return parsed;
}

/**
 * Upload a short webcam clip (mp4/webm bytes in memory) and return the Presage job id.
 * `mimeHint` is accepted for callers; the upload-url API keys off file size + hr_br.
 */
export async function queueVideoHrRr(
  apiKey: string,
  videoBytes: Buffer | Uint8Array,
  mimeHint?: string | null,
  options: PresageOptions = {},
): Promise<string> {
  const key = resolveApiKey(apiKey);
  const bytes = asBytes(videoBytes);
  if (bytes.byteLength === 0) {
    throw new Error("videoBytes is empty");
  }
  void mimeHint;

  const fetchImpl = options.fetchImpl ?? fetch;
  const fileSize = bytes.byteLength;

  // Presage retired /v1/* on api.physiology (API Gateway 403 "Missing Authentication Token").
  const start = await fetchImpl(`${BASE}/v2/upload-url`, {
    method: "POST",
    headers: jsonHeaders(key),
    body: JSON.stringify({
      file_size: fileSize,
      hr_br: { to_process: true },
    }),
  });

  if (start.status === 401) {
    throw new Error("Presage unauthorized — check PRESAGE_API_KEY");
  }
  if (!start.ok) {
    const detail = await start.text().catch(() => "");
    throw new Error(`Presage upload-url failed: ${start.status} ${detail}`.trim());
  }

  const startJson = (await start.json()) as {
    id?: unknown;
    upload_id?: unknown;
    urls?: unknown;
  };
  const vidId = typeof startJson.id === "string" ? startJson.id : "";
  const uploadId = typeof startJson.upload_id === "string" ? startJson.upload_id : "";
  if (!vidId) throw new Error("missing id");
  if (!uploadId) throw new Error("missing upload_id");
  const urls = Array.isArray(startJson.urls) ? startJson.urls : [];
  if (urls.length === 0) {
    throw new Error("Presage upload-url returned no part urls");
  }

  const parts: Array<{ ETag: string; PartNumber: number }> = [];
  let offset = 0;
  for (let idx = 0; idx < urls.length; idx += 1) {
    const url = urls[idx];
    if (typeof url !== "string" || !url) throw new Error("bad upload url");
    assertSafePresageUploadUrl(url);
    const end = Math.min(offset + PART_CHUNK, bytes.byteLength);
    const slice = bytes.subarray(offset, end);
    const put = await fetchImpl(url, {
      method: "PUT",
      body: slice,
      redirect: "error",
    });
    if (!put.ok) {
      throw new Error(`Presage part upload failed: ${put.status}`);
    }
    const etag = put.headers.get("ETag") ?? '""';
    parts.push({ ETag: etag, PartNumber: idx + 1 });
    offset = end;
    if (offset >= bytes.byteLength) break;
  }

  if (offset < bytes.byteLength || parts.length === 0) {
    throw new Error("Presage multipart upload incomplete");
  }

  const complete = await fetchImpl(`${BASE}/v2/complete`, {
    method: "POST",
    headers: jsonHeaders(key),
    body: JSON.stringify({
      id: vidId,
      upload_id: uploadId,
      parts,
    }),
  });
  // Presage returns 203 on successful complete.
  if (!complete.ok) {
    const detail = await complete.text().catch(() => "");
    throw new Error(`Presage complete failed: ${complete.status} ${detail}`.trim());
  }
  return vidId;
}

/** Poll retrieve-data until 200 or timeout (201 / other → wait 1s). */
export async function retrieveResult(
  apiKey: string,
  id: string,
  timeoutSec: number,
  options: PresageOptions = {},
): Promise<unknown> {
  const key = resolveApiKey(apiKey);
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = Date.now() + Math.max(0, timeoutSec) * 1000;

  while (true) {
    if (Date.now() >= deadline) {
      throw new Error("Presage retrieve timeout");
    }
    const res = await fetchImpl(`${BASE}/retrieve-data`, {
      method: "POST",
      headers: jsonHeaders(key),
      body: JSON.stringify({ id, reshape: false }),
    });
    const status = res.status;
    if (status === 200) {
      return res.json();
    }
    if (status === 401) {
      throw new Error("Presage unauthorized");
    }
    await sleep(1000);
  }
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Token-boundary key match. Prefer exact keys via `firstF64` direct lookup;
 * fuzzy path only when the token is a whole segment (split on non-alnum).
 * Denylists collision-prone names (`error`/`current` vs `rr`).
 */
function fieldKeyMatches(fieldKey: string, want: string): boolean {
  const lk = fieldKey.toLowerCase().trim();
  if (!lk || VITAL_KEY_DENY.has(lk)) return false;
  if (lk === want) return true;
  if (want === "hr" && (lk === "hrv" || lk.startsWith("hrv_") || lk.includes("hrv"))) {
    return false;
  }
  const tokens = lk.split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.includes(want);
}

function firstF64(data: unknown, keys: string[]): number | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;

  for (const key of keys) {
    const direct = asFiniteNumber(record[key]);
    if (direct != null) return direct;
    const arr = record[key];
    if (Array.isArray(arr) && arr.length > 0) {
      const last = asFiniteNumber(arr[arr.length - 1]);
      if (last != null) return last;
    }
  }

  for (const [k, val] of Object.entries(record)) {
    if (!keys.some((want) => fieldKeyMatches(k, want))) continue;
    const n = asFiniteNumber(val);
    if (n != null) return n;
    if (Array.isArray(val)) {
      for (let i = val.length - 1; i >= 0; i -= 1) {
        const item = asFiniteNumber(val[i]);
        if (item != null) return item;
      }
    }
  }
  return null;
}

function asBool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (["true", "yes", "1", "present", "detected"].includes(s)) return true;
    if (["false", "no", "0", "absent", "none"].includes(s)) return false;
  }
  return null;
}

/** Explicit vendor face/quality flags only — never infer from empty scalars. */
function faceSignalFromResult(data: unknown): boolean | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const directKeys = [
    "face_detected",
    "face_present",
    "has_face",
    "face",
    "no_face",
  ];
  for (const key of directKeys) {
    if (!(key in record)) continue;
    const raw = asBool(record[key]);
    if (raw == null) continue;
    return key === "no_face" ? !raw : raw;
  }
  return null;
}

function summarize(
  hr: number | null,
  rr: number | null,
  hrv: number | null,
  stress: number | null,
): string {
  return `HR=${hr} RR=${rr} HRV/RMSSD=${hrv} stress_index=${stress}`;
}

/** Map a Presage retrieve payload into coach-facing vitals scalars. */
export function vitalsFromResult(data: unknown): PresageVitals {
  const hr = firstF64(data, ["hr", "heart_rate", "pulse_rate", "pulse"]);
  const rr = firstF64(data, ["rr", "br", "breathing_rate", "respiration_rate"]);
  const hrv = firstF64(data, ["hrv", "rmssd", "hrv_rmssd"]);
  const stress = firstF64(data, ["stress", "stress_index", "baevsky", "baevsky_stress_index"]);

  // Dual signal (Presage scalars): high stress index OR low HRV.
  // Ignore 0 / sentinel HRV as n/a (vendor noise), not "maximally stressed".
  const hrvUsable = hrv != null && hrv > 0;
  const stressUsable = stress != null && stress > 0;
  const stressed =
    (stressUsable && stress > STRESS_INDEX_STRESSED_MIN) ||
    (hrvUsable && hrv < HRV_STRESSED_MAX);
  const focusOk =
    !stressed && (hr == null || (hr >= 50 && hr <= 110));

  return {
    heart_rate: hr,
    breathing_rate: rr,
    stress_index: stress,
    stressed,
    focus_ok: focusOk,
    source: "presage",
    raw_summary: summarize(hr, rr, hrv, stress),
    face_detected: faceSignalFromResult(data),
  };
}

/**
 * Queue a short clip, wait for Presage, return parsed vitals.
 * Default retrieve timeout: 60s.
 */
export async function analyzeClip(
  apiKey: string,
  videoBytes: Buffer | Uint8Array,
  mimeHint?: string | null,
  options: PresageOptions & { timeoutSec?: number } = {},
): Promise<PresageVitals> {
  const id = await queueVideoHrRr(apiKey, videoBytes, mimeHint, options);
  const raw = await retrieveResult(
    apiKey,
    id,
    options.timeoutSec ?? DEFAULT_RETRIEVE_TIMEOUT_SEC,
    options,
  );
  return vitalsFromResult(raw);
}
