import type { PresageVitals } from "./types.ts";

const BASE = "https://api.physiology.presagetech.com";
const PART_CHUNK = 5 * 1024 * 1024;
const DEFAULT_RETRIEVE_TIMEOUT_SEC = 60;

/** Baevsky / Presage stress_index above this → vitals.stressed. */
export const STRESS_INDEX_STRESSED_MIN = 150;
/** RMSSD/HRV below this (ms) → vitals.stressed (VIDEOINPUT-aligned). */
export const HRV_STRESSED_MAX = 20;

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

  const start = await fetchImpl(`${BASE}/v1/upload-url`, {
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

  const parts: Array<{ ETag: string; PartNumber: number }> = [];
  let offset = 0;
  for (let idx = 0; idx < urls.length; idx += 1) {
    const url = urls[idx];
    if (typeof url !== "string" || !url) throw new Error("bad upload url");
    const end = Math.min(offset + PART_CHUNK, bytes.byteLength);
    const slice = bytes.subarray(offset, end);
    const put = await fetchImpl(url, {
      method: "PUT",
      body: slice,
    });
    if (!put.ok) {
      throw new Error(`Presage part upload failed: ${put.status}`);
    }
    const etag = put.headers.get("ETag") ?? '""';
    parts.push({ ETag: etag, PartNumber: idx + 1 });
    offset = end;
    if (offset >= bytes.byteLength) break;
  }

  const complete = await fetchImpl(`${BASE}/v1/complete`, {
    method: "POST",
    headers: jsonHeaders(key),
    body: JSON.stringify({
      id: vidId,
      upload_id: uploadId,
      parts,
    }),
  });
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

/** Fuzzy field match — keep short tokens like `hr` from stealing `hrv` / `hrv_rmssd`. */
function fieldKeyMatches(fieldKey: string, want: string): boolean {
  const lk = fieldKey.toLowerCase();
  if (lk === want) return true;
  if (want === "hr" && (lk === "hrv" || lk.startsWith("hrv_") || lk.includes("hrv"))) {
    return false;
  }
  return lk.includes(want);
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
  // When Presage is unavailable, observe returns vitals=null (no invented stress).
  const stressed =
    (stress != null && stress > STRESS_INDEX_STRESSED_MIN) ||
    (hrv != null && hrv < HRV_STRESSED_MAX);
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
