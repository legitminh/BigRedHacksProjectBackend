/**
 * POST /v1/camera/observe — desktop uploads a short clip; server runs Presage + presence.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type { Config } from "../config.ts";
import { HttpError, readJson, sendJson } from "../http.ts";
import type { PublicUser } from "../store/types.ts";
import { analyzeClip, type PresageOptions } from "./presage.ts";
import {
  isSilentCameraPhase,
  observePresence,
  type AttentionSignal,
  type CameraPhase,
} from "./presence.ts";
import { CameraSessionStore } from "./sessionStore.ts";
import type { ClientObserveMeta, PresageVitals } from "./types.ts";

/** ~8MB decoded → ~11MB base64 + JSON envelope. */
export const CAMERA_BODY_MAX = 12 * 1024 * 1024;
const MAX_DECODED_BYTES = 8 * 1024 * 1024;

export type CameraAnalyzeFn = (
  apiKey: string,
  videoBytes: Buffer,
  mimeHint: string,
) => Promise<PresageVitals>;

export type CameraRouteDeps = {
  config: Config;
  now: () => Date;
  store: CameraSessionStore;
  analyzeClip?: CameraAnalyzeFn;
  /** Optional fetch/sleep injection for Presage (tests). */
  presageOptions?: PresageOptions;
};

type ObserveBody = {
  session_id?: unknown;
  phase?: unknown;
  mime?: unknown;
  data_base64?: unknown;
  client_meta?: unknown;
};

function parsePhase(value: unknown): CameraPhase {
  if (value === "active" || value === "paused" || value === "break") return value;
  throw new HttpError(400, "invalid_phase", "phase must be active, paused, or break.");
}

function parseMime(value: unknown): string {
  if (typeof value !== "string") {
    throw new HttpError(400, "invalid_mime", "mime is required.");
  }
  const mime = value.trim().toLowerCase();
  if (
    mime === "video/mp4" ||
    mime === "video/webm" ||
    mime === "image/jpeg" ||
    mime === "image/jpg"
  ) {
    return mime === "image/jpg" ? "image/jpeg" : mime;
  }
  throw new HttpError(400, "invalid_mime", "mime must be video/mp4, video/webm, or image/jpeg.");
}

function parseAttention(value: unknown): AttentionSignal | null {
  if (
    value === "present" ||
    value === "absent" ||
    value === "looking_down" ||
    value === "looking_away"
  ) {
    return value;
  }
  return null;
}

function parseLastNudgeAck(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ack = value.trim();
  if (!ack || ack.length > 64) return null;
  return ack;
}

function parseClientMeta(raw: unknown): {
  brightness: number | null;
  brightnessMeasured: boolean;
  faceDetected: boolean | null;
  attention: AttentionSignal | null;
  hasLocalFace: boolean;
  lastNudgeAck: string | null;
} {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      brightness: null,
      brightnessMeasured: false,
      faceDetected: null,
      attention: null,
      hasLocalFace: false,
      lastNudgeAck: null,
    };
  }
  const meta = raw as ClientObserveMeta;
  const b = meta.brightness;
  const brightness = typeof b === "number" && Number.isFinite(b) ? b : null;
  const brightnessMeasured =
    meta.brightness_measured === true ||
    (typeof b === "number" && Number.isFinite(b) && b > 0);
  const hasLocalFace = typeof meta.face_detected === "boolean";
  const faceDetected = hasLocalFace ? (meta.face_detected as boolean) : null;
  return {
    brightness,
    brightnessMeasured,
    faceDetected,
    attention: parseAttention(meta.attention),
    hasLocalFace,
    lastNudgeAck: parseLastNudgeAck(meta.last_nudge_ack),
  };
}

/**
 * Map Presage vitals → faceDetected for the presence ladder.
 * - Usable scalars / stressed → present (true)
 * - Explicit vendor face_detected=false → away (false)
 * - Successful job with empty scalars and no face signal → uncertain (null)
 *   (poor lighting / empty vendor payload must not invent left_desk)
 */
export function faceFromVitals(vitals: PresageVitals | null): boolean | null {
  if (!vitals) return null;
  if (vitals.face_detected === true) return true;
  if (vitals.face_detected === false) return false;
  // Any usable Presage scalar (incl. stress-only / HRV-only) means a face was in frame.
  // Important for stress→suggest_break: do not route stressed clips into the away ladder.
  if (
    vitals.heart_rate != null ||
    vitals.breathing_rate != null ||
    vitals.stress_index != null ||
    vitals.stressed
  ) {
    return true;
  }
  // Empty success → uncertain, not proven absence.
  return null;
}

/**
 * Local Vision is PRIMARY for desk-away when the client posts a boolean.
 * Presage face / scalars only fill in when local face is absent from client_meta.
 * Empty Presage success must never block a local-away signal.
 */
export function mergeFaceDetected(
  clientFace: boolean | null,
  hasLocalFace: boolean,
  presageFace: boolean | null,
): boolean | null {
  if (hasLocalFace && typeof clientFace === "boolean") return clientFace;
  return presageFace;
}

export async function handleCameraObserve(
  req: IncomingMessage,
  res: ServerResponse,
  user: PublicUser,
  deps: CameraRouteDeps,
): Promise<void> {
  const raw = (await readJson(req, CAMERA_BODY_MAX)) as ObserveBody;
  const sessionId = typeof raw.session_id === "string" ? raw.session_id.trim() : "";
  if (!sessionId || sessionId.length > 128) {
    throw new HttpError(400, "invalid_session", "session_id is required.");
  }
  const phase = parsePhase(raw.phase);
  const mime = parseMime(raw.mime);
  const b64 = typeof raw.data_base64 === "string" ? raw.data_base64.trim() : "";
  if (!b64) {
    throw new HttpError(400, "invalid_data", "data_base64 is required.");
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(b64, "base64");
  } catch {
    throw new HttpError(400, "invalid_data", "data_base64 is not valid base64.");
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_DECODED_BYTES) {
    throw new HttpError(400, "invalid_data", "Clip is empty or exceeds 8MB.");
  }

  const client = parseClientMeta(raw.client_meta);
  const { brightness, brightnessMeasured, attention, lastNudgeAck } = client;

  await deps.store.withObserveLock(user.id, sessionId, async () => {
    const apiKey = deps.config.presageApiKey ?? process.env.PRESAGE_API_KEY ?? null;
    let vitals: PresageVitals | null = null;
    let presageFace: boolean | null = null;
    let mimeNote: string | null = null;

    const isVideo = mime.startsWith("video/");
    const quietPhase = isSilentCameraPhase(phase);
    // Local Vision owns desk-away / looking_down. Skip Presage whenever the client
    // posted a face boolean — otherwise each tick blocks ~45s on rPPG and away /
    // look_back never confirm in a normal mission (needs 2 observes).
    const localOwnsPresence = client.hasLocalFace;
    // Privacy: do not upload face video to Presage during pause/break.
    // Stress vitals via Presage are secondary; re-enable sparsely later if needed.
    const mayUploadPresage =
      isVideo && Boolean(apiKey) && !quietPhase && !localOwnsPresence;

    if (mayUploadPresage && apiKey) {
      try {
        const analyze =
          deps.analyzeClip ??
          ((key, buf, hint) =>
            analyzeClip(key, buf, hint, {
              ...deps.presageOptions,
              timeoutSec: 45,
            }));
        vitals = await analyze(apiKey, bytes, mime);
        presageFace = faceFromVitals(vitals);
      } catch (err) {
        console.warn(
          "[camera/observe] Presage failed:",
          err instanceof Error ? err.message : err,
        );
        // Transport/auth/timeout must not invent leave — but local Vision still can.
        presageFace = null;
      }
    } else if (localOwnsPresence && isVideo && !quietPhase) {
      mimeNote = "Presage skipped — local Vision owns presence";
      console.info(
        "[camera/observe] local face=%s attention=%s (Presage skipped)",
        client.faceDetected,
        attention ?? "n/a",
      );
    } else if (!isVideo) {
      // JPEG-only: no Presage vitals; leave/stress from Presage unavailable.
      presageFace = null;
      mimeNote =
        "JPEG observe skips Presage — leave/stress detection requires video/mp4 or video/webm";
    } else if (quietPhase && isVideo && apiKey) {
      mimeNote = "Presage upload skipped during pause/break";
    }

    // Drop pixels ASAP (locals go out of scope after response).
    bytes = Buffer.alloc(0);

    // Local Vision face is PRIMARY for desk-away; Presage only when client omitted it.
    const faceDetected = mergeFaceDetected(
      client.faceDetected,
      client.hasLocalFace,
      presageFace,
    );

    const presenceOut = observePresence(deps.store, {
      userId: user.id,
      sessionId,
      phase,
      faceDetected,
      brightness,
      brightnessMeasured,
      attention,
      lastNudgeAck,
      stressed: vitals?.stressed ?? null,
      now: deps.now(),
    });

    const watchingNote = mimeNote
      ? `${presenceOut.watching_note} · ${mimeNote}`
      : presenceOut.watching_note;

    sendJson(res, 200, {
      ok: true,
      presence: presenceOut.presence,
      face_detected: faceDetected,
      vitals: vitals
        ? {
            heart_rate: vitals.heart_rate,
            breathing_rate: vitals.breathing_rate,
            stress_index: vitals.stress_index,
            stressed: vitals.stressed,
            focus_ok: vitals.focus_ok,
            source: vitals.source,
          }
        : null,
      nudge: presenceOut.nudge,
      watching_note: watchingNote,
    });
  });
}
