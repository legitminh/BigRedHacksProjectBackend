/**
 * Sparse camera presence / accountability nudges (VIDEOINPUT spirit).
 * No biometric numbers in spoken lines. Quiet during pause/break.
 */

import {
  type CameraPresenceSession,
  type CameraSessionStore,
  type LadderStep,
  type PresenceState,
} from "./sessionStore.ts";

export type { PendingLadderNudge } from "./sessionStore.ts";

export type CameraPhase = "active" | "paused" | "break";

/** Desktop: when kind === "suggest_break" → emit-only `suggest_break_timer` (never auto-start). */
export const SUGGEST_BREAK_KIND = "suggest_break" as const;
/** Calm breath fallback after a recent break suggestion. */
export const STRESSED_BREATH_KIND = "stressed" as const;

export type StressNudgeKind = typeof SUGGEST_BREAK_KIND | typeof STRESSED_BREATH_KIND;

export type PresenceNudge = {
  kind: string;
  text: string;
};

/**
 * Local Vision posture from desktop (F1).
 * looking_down = face present, head-down / phone lap.
 * looking_away = face present, head yaw / off-center (not facing screen).
 */
export type AttentionSignal =
  | "present"
  | "absent"
  | "looking_down"
  | "looking_away";

export type ObservePresenceInput = {
  userId: string;
  sessionId: string;
  phase: CameraPhase;
  faceDetected: boolean | null;
  brightness?: number | null;
  /**
   * When false/omitted, brightness 0 (common placeholder) is ignored.
   * Obstructed only applies to a measured low reading, and never overrides a detected face.
   */
  brightnessMeasured?: boolean;
  /** Optional posture from client; looking_down/away never count as left_desk. */
  attention?: AttentionSignal | null;
  /**
   * Desktop ack of last successfully delivered camera nudge kind (F4).
   * Consumes `pendingLadderNudge` when it matches; otherwise that rung re-emits sparsely.
   */
  lastNudgeAck?: string | null;
  stressed?: boolean | null;
  now?: Date;
};

export type ObservePresenceResult = {
  presence: PresenceState;
  nudge: PresenceNudge | null;
  watching_note: string;
};

/** Need 2 away observes (or held candidate time) so a single glance does not confirm leave. */
export const AWAY_CONFIRM_OBSERVES = 2;
/** Time-based confirm when observes are denser than the ~25–30s desktop cadence. */
export const AWAY_CONFIRM_MS = 5_000;
/** looking_down: slightly cautious — 2 observes or short hold (phone-lap posture). */
export const LOOK_DOWN_CONFIRM_OBSERVES = 2;
export const LOOK_DOWN_CONFIRM_MS = 5_000;
/**
 * looking_away: client may already majority-vote yaw — fire on first observe
 * (or ~3s hold if ticks are denser).
 */
export const LOOK_AWAY_CONFIRM_OBSERVES = 1;
export const LOOK_AWAY_CONFIRM_MS = 3_000;
/**
 * Sparse look_back cooldown (~45s band). Shared with stress-family spirit:
 * not every observe tick.
 */
export const LOOK_BACK_COOLDOWN_MS = 45_000;
export const LOOK_BACK_KIND = "look_back" as const;
/**
 * Sparse re-emit of an unacked ladder nudge (~one desktop observe cycle).
 * Prevents silent consume when overlay/TTS drops the first delivery.
 */
export const NUDGE_REEMIT_MS = 30_000;
/** Dhanvi presence.first_callback_s — first left_desk rung after confirmed leave. */
export const LEFT_FRAME_FIRST_CALLBACK_MS = 25_000;
/** Dhanvi demo profile first_callback_s (not wired as a runtime switch). */
export const LEFT_FRAME_FIRST_CALLBACK_DEMO_MS = 10_000;
/**
 * Absence ladder after left_frame is confirmed (active only) — case-catalog D1 spirit.
 * Timings are wall-clock from when the away candidate began (not from confirm tick),
 * so with ~25–30s observe cadence a real away gets the first callback on the confirming
 * observe (~25–30s), not an extra full period later.
 *
 * Kind is an internal tag — spoken `text` is what the student hears. Never surface
 * the kind string in UI/TTS.
 *
 * Presage / VIDEOINPUT only (no local LLM, no phone-box detector):
 * - `left_desk`: no usable face (D1). Do **not** accuse phone (that is C1 with a box).
 * - Mid-ladder `suggest_break`: ~3 min away → optional break invite (D1), not stress.
 * - `left_desk_pause`: ~10 min → stop nagging (soft stand-in for pause_session).
 * - `welcome_back` / `camera_obstructed` / stress family: unchanged roles.
 */
const LADDER: Array<{ step: LadderStep; afterMs: number; kind: string; text: string }> = [
  {
    step: "first",
    afterMs: LEFT_FRAME_FIRST_CALLBACK_MS,
    kind: "left_desk",
    text: "You've stepped away. Come back to the work when you can.",
  },
  {
    step: "second",
    afterMs: 180_000,
    // Desktop maps suggest_break → Accept/Not now break card (never auto-starts).
    kind: SUGGEST_BREAK_KIND,
    text: "Still away — optional five-minute break so you know when to return?",
  },
  {
    step: "pause",
    afterMs: 600_000,
    kind: "left_desk_pause",
    // Soft quiet (catalog D1 ~10 min pause_session); does not force mission pause.
    text: "I'll stay quiet until you're back at the desk.",
  },
];
/**
 * Cover / dark lens — speak sooner than a full away ladder for snappy UX
 * (Waypoint ~8s; Dhanvi presence held ~30s before speaking).
 */
export const OBSTRUCTED_MS = 8_000;
/**
 * VIDEOINPUT-aligned timing reference for FE/BE sync.
 * Continuous gaze is primarily desktop live-feed; BE merges `client_meta.attention`
 * on sparse clip observes. Prefer FE-local presence for sub-~25s ticks — a
 * meta-only observe path would still hit the ~1/25s rate limit.
 *
 * Dhanvi attention.yaml: glance_ignore_s=8, look_up_or_away_s=30 (FE hold before
 * posting looking_away). BE confirms looking_away fast once posted.
 */
export const PRESENCE_TIMINGS = {
  glanceIgnoreS: 8,
  lookUpOrAwayS: 30,
  lookAwayConfirmObserves: LOOK_AWAY_CONFIRM_OBSERVES,
  lookAwayConfirmMs: LOOK_AWAY_CONFIRM_MS,
  lookDownConfirmObserves: LOOK_DOWN_CONFIRM_OBSERVES,
  lookDownConfirmMs: LOOK_DOWN_CONFIRM_MS,
  leftFrameFirstCallbackMs: LEFT_FRAME_FIRST_CALLBACK_MS,
  leftFrameFirstCallbackDemoMs: LEFT_FRAME_FIRST_CALLBACK_DEMO_MS,
  cameraObstructedMs: OBSTRUCTED_MS,
  lookBackCooldownMs: LOOK_BACK_COOLDOWN_MS,
  awayConfirmObserves: AWAY_CONFIRM_OBSERVES,
  awayConfirmMs: AWAY_CONFIRM_MS,
} as const;
/** Shared cooldown for stress-family nudges (`suggest_break` | `stressed`). */
export const STRESS_COOLDOWN_MS = 180_000;
const RETURN_CONFIRM_MS = 2_000;
/** Catalog D2: only welcome after a real leave (≥20 s), not a blink. */
const WELCOME_BACK_MIN_ABSENT_MS = 20_000;

// Keep under ~12 words for lock-in; never include digits (HR/RR/%). Spell out "five".
const SUGGEST_BREAK_TEXT = "Feeling tense — optional five-minute break?";
const STRESSED_BREATH_TEXT = "You seem tense — one slow breath, then back.";
const WELCOME_BACK_TEXT =
  "Welcome back — good to see you. Let's pick the work back up.";
const CAMERA_OBSTRUCTED_TEXT =
  "I can't see you clearly. Check the camera or lighting.";
/**
 * Face still present (looking_down posture) — not left_desk, not Presage phone.
 * Phone only as soft hedge; real phone accusation needs a box detector (Audit E).
 */
export const LOOK_BACK_TEXT =
  "Eyes on the work — put the phone down if you're on it.";
/** Dhanvi head_turned / looking_away line (speak once, then cooldown). */
export const LOOK_AWAY_TEXT =
  "You're looking away. Turn back to the work.";

/** Pause and break phases: no spoken nudges. */
export function isSilentCameraPhase(phase: CameraPhase): boolean {
  return phase === "paused" || phase === "break";
}

function classify(
  faceDetected: boolean | null,
  brightness: number | null | undefined,
  brightnessMeasured?: boolean,
): PresenceState {
  // Face wins over lighting: a detected face must not become an obstructed nag.
  if (faceDetected === true) return "present";
  const measured =
    brightnessMeasured === true ||
    (typeof brightness === "number" && Number.isFinite(brightness) && brightness > 0);
  if (measured && typeof brightness === "number" && brightness < 25) {
    return "camera_obstructed";
  }
  if (faceDetected === false) return "left_frame";
  return "uncertain";
}

function watchingNote(presence: PresenceState): string {
  switch (presence) {
    case "present":
      return "Camera accountability · present";
    case "left_frame":
      return "Camera accountability · away from desk";
    case "camera_obstructed":
      return "Camera accountability · camera unclear";
    default:
      return "Camera accountability · checking";
  }
}

function resetAbsence(session: CameraPresenceSession): void {
  session.awayCandidateSince = null;
  session.consecutiveAway = 0;
  session.absentSince = null;
  session.ladderSpoken.clear();
  session.linesSpoken = 0;
  session.ladderQuiet = false;
  session.pendingLadderNudge = null;
  session.leftConfirmed = false;
  session.welcomedBack = false;
  session.presentSince = null;
}

/** Consume pending ladder rung when desktop acks the same kind. */
function applyLadderAck(
  session: CameraPresenceSession,
  lastNudgeAck: string | null | undefined,
): void {
  const pending = session.pendingLadderNudge;
  if (!pending || typeof lastNudgeAck !== "string" || !lastNudgeAck) return;
  if (lastNudgeAck !== pending.kind) return;
  session.ladderSpoken.add(pending.step);
  if (pending.step === "pause") session.ladderQuiet = true;
  session.pendingLadderNudge = null;
}

/**
 * Re-emit unacked ladder nudge after NUDGE_REEMIT_MS, or null while waiting.
 * Blocks advancing to the next rung until ack.
 */
function ladderNudgeFromPending(
  session: CameraPresenceSession,
  silentPhase: boolean,
  now: Date,
): PresenceNudge | null {
  const pending = session.pendingLadderNudge;
  if (!pending || silentPhase) return null;
  if (now.getTime() - pending.lastEmittedAt.getTime() < NUDGE_REEMIT_MS) {
    return null;
  }
  pending.lastEmittedAt = now;
  return { kind: pending.kind, text: pending.text };
}

function resetLookingDown(session: CameraPresenceSession): void {
  session.lookingDownCandidateSince = null;
  session.consecutiveLookingDown = 0;
}

function isGazeAway(attention: AttentionSignal | null | undefined): boolean {
  return attention === "looking_down" || attention === "looking_away";
}

/**
 * Sustained looking_down / looking_away → sparse look_back.
 * Honest in-frame posture signal (Audit E): face still here — never left_desk,
 * never invent Presage phone. looking_away confirms faster (yaw already majority
 * on the client); looking_down keeps a short 2-observe confirm.
 */
function mapLookingDownToNudge(opts: {
  attention: AttentionSignal | null | undefined;
  silentPhase: boolean;
  session: CameraPresenceSession;
  now: Date;
  cooldownMs?: number;
}): PresenceNudge | null {
  if (!isGazeAway(opts.attention)) {
    resetLookingDown(opts.session);
    return null;
  }

  opts.session.consecutiveLookingDown += 1;
  if (opts.session.lookingDownCandidateSince == null) {
    opts.session.lookingDownCandidateSince = opts.now;
  }
  const held =
    opts.now.getTime() - opts.session.lookingDownCandidateSince.getTime();
  const needObserves =
    opts.attention === "looking_away"
      ? LOOK_AWAY_CONFIRM_OBSERVES
      : LOOK_DOWN_CONFIRM_OBSERVES;
  const needHoldMs =
    opts.attention === "looking_away"
      ? LOOK_AWAY_CONFIRM_MS
      : LOOK_DOWN_CONFIRM_MS;
  const confirmed =
    opts.session.consecutiveLookingDown >= needObserves || held >= needHoldMs;
  if (!confirmed || opts.silentPhase) return null;

  const cooldown = opts.cooldownMs ?? LOOK_BACK_COOLDOWN_MS;
  const last = opts.session.lastLookBackNudgeAt?.getTime() ?? 0;
  if (opts.now.getTime() - last < cooldown) return null;

  opts.session.lastLookBackNudgeAt = opts.now;
  const text =
    opts.attention === "looking_away" ? LOOK_AWAY_TEXT : LOOK_BACK_TEXT;
  return { kind: LOOK_BACK_KIND, text };
}

/**
 * Whether stress should surface a break suggestion (vs breath fallback).
 * Prefer `suggest_break` unless the last stress nudge was already a break offer.
 */
export function shouldSuggestBreak(lastStressKind: StressNudgeKind | null): boolean {
  return lastStressKind !== SUGGEST_BREAK_KIND;
}

/**
 * Stress nudge policy:
 * - Shared STRESS_COOLDOWN_MS between any stress-family lines (sparse).
 * - Prefer `suggest_break` (voluntary five-minute invite — suggestion only).
 * - Alternate with `stressed` (slow breath) so break offers are not every tick.
 * - Silent on paused/break; quiet phases also refresh the stress cooldown clock
 *   so resuming after a break does not immediately re-nudge.
 * - No biometric numbers in copy.
 *
 * Desktop: nudge.kind === "suggest_break" → emit-only suggest_break_timer locally.
 */
export function mapStressedToNudge(opts: {
  stressed: boolean | null | undefined;
  silentPhase: boolean;
  msSinceLastStressNudge: number;
  lastStressKind: StressNudgeKind | null;
  cooldownMs?: number;
}): PresenceNudge | null {
  if (opts.silentPhase || opts.stressed !== true) return null;
  const cooldown = opts.cooldownMs ?? STRESS_COOLDOWN_MS;
  if (opts.msSinceLastStressNudge < cooldown) return null;

  if (shouldSuggestBreak(opts.lastStressKind)) {
    return { kind: SUGGEST_BREAK_KIND, text: SUGGEST_BREAK_TEXT };
  }
  return { kind: STRESSED_BREATH_KIND, text: STRESSED_BREATH_TEXT };
}

/** Apply one camera observe tick; returns at most one short nudge. */
export function observePresence(
  store: CameraSessionStore,
  input: ObservePresenceInput,
): ObservePresenceResult {
  const now = input.now ?? new Date();
  store.prune(now);
  const session = store.getOrCreate(input.userId, input.sessionId, now);
  const silentPhase = isSilentCameraPhase(input.phase);

  // Desktop speak-ack: consume pending ladder rung only after successful delivery.
  applyLadderAck(session, input.lastNudgeAck);

  // Quiet phases: hold the stress cooldown clock so we do not fire a stress
  // line the moment the user leaves break/pause (a five-minute break already
  // outlasts STRESS_COOLDOWN_MS).
  if (silentPhase) {
    session.lastStressNudgeAt = now;
  }

  let raw = classify(
    input.faceDetected,
    input.brightness ?? null,
    input.brightnessMeasured,
  );
  // Gaze-away means face is still in frame — never left_desk.
  if (
    isGazeAway(input.attention) &&
    (raw === "left_frame" || raw === "uncertain")
  ) {
    raw = "present";
  }

  let nudge: PresenceNudge | null = null;

  if (raw === "camera_obstructed") {
    resetLookingDown(session);
    session.presence = "camera_obstructed";
    session.presentSince = null;
    if (session.obstructedSince == null) session.obstructedSince = now;
    const held = now.getTime() - session.obstructedSince.getTime();
    if (!silentPhase && !session.obstructedSaid && held >= OBSTRUCTED_MS) {
      session.obstructedSaid = true;
      nudge = {
        kind: "camera_obstructed",
        text: CAMERA_OBSTRUCTED_TEXT,
      };
    }
    return { presence: session.presence, nudge, watching_note: watchingNote(session.presence) };
  }
  session.obstructedSince = null;
  // Allow one more obstructed line next time the lens is covered.
  if (raw === "present") session.obstructedSaid = false;

  if (raw === "uncertain") {
    resetLookingDown(session);
    // Ignore brief uncertainty — do not chatter.
    if (session.presence !== "left_frame") {
      session.presence = "uncertain";
    }
    return { presence: session.presence, nudge: null, watching_note: watchingNote(session.presence) };
  }

  if (raw === "left_frame") {
    resetLookingDown(session);
    session.consecutiveAway += 1;
    if (session.awayCandidateSince == null) session.awayCandidateSince = now;
    const heldCandidate = now.getTime() - session.awayCandidateSince.getTime();
    const confirmed =
      session.consecutiveAway >= AWAY_CONFIRM_OBSERVES || heldCandidate >= AWAY_CONFIRM_MS;

    if (!confirmed) {
      session.presence = "uncertain";
      return { presence: session.presence, nudge: null, watching_note: watchingNote(session.presence) };
    }

    if (session.absentSince == null) {
      // Credit time from the first away candidate tick so ladder thresholds match
      // real desk-absence, not "time since the confirming observe".
      session.absentSince = session.awayCandidateSince ?? now;
      session.leftConfirmed = true;
      session.welcomedBack = false;
    }
    session.presentSince = null;
    session.presence = "left_frame";
    const absentMs = now.getTime() - session.absentSince.getTime();

    // Quiet on paused/break; after pause rung is acked stay silent for this absence.
    // Unacked rungs stay pending and re-emit sparsely — never permanently consume on emit.
    if (!silentPhase && !session.ladderQuiet) {
      if (session.pendingLadderNudge) {
        nudge = ladderNudgeFromPending(session, silentPhase, now);
      } else {
        for (const rung of LADDER) {
          if (session.ladderSpoken.has(rung.step) || absentMs < rung.afterMs) continue;
          session.linesSpoken += 1;
          nudge = { kind: rung.kind, text: rung.text };
          session.pendingLadderNudge = {
            step: rung.step,
            kind: rung.kind,
            text: rung.text,
            lastEmittedAt: now,
          };
          if (rung.kind === SUGGEST_BREAK_KIND) {
            session.lastStressNudgeAt = now;
            session.lastStressNudgeKind = SUGGEST_BREAK_KIND;
          }
          break;
        }
      }
    }
    return { presence: session.presence, nudge, watching_note: watchingNote(session.presence) };
  }

  // present
  session.consecutiveAway = 0;
  session.awayCandidateSince = null;

  if (session.leftConfirmed && session.absentSince != null) {
    if (session.presentSince == null) session.presentSince = now;
    const backMs = now.getTime() - session.presentSince.getTime();
    if (backMs >= RETURN_CONFIRM_MS) {
      const absentMs = now.getTime() - session.absentSince.getTime();
      if (
        !silentPhase &&
        !session.welcomedBack &&
        absentMs >= WELCOME_BACK_MIN_ABSENT_MS
      ) {
        session.welcomedBack = true;
        nudge = { kind: "welcome_back", text: WELCOME_BACK_TEXT };
      }
      resetAbsence(session);
    }
  } else {
    session.absentSince = null;
    session.presentSince = null;
  }

  session.presence = "present";

  // Gaze-away (face still here) before stress — posture nudge is more specific.
  if (!nudge) {
    nudge = mapLookingDownToNudge({
      attention: input.attention,
      silentPhase,
      session,
      now,
    });
  } else if (!isGazeAway(input.attention)) {
    resetLookingDown(session);
  }

  if (!nudge) {
    const last = session.lastStressNudgeAt?.getTime() ?? 0;
    const stressNudge = mapStressedToNudge({
      stressed: input.stressed,
      silentPhase,
      msSinceLastStressNudge: now.getTime() - last,
      lastStressKind: session.lastStressNudgeKind,
    });
    if (stressNudge) {
      session.lastStressNudgeAt = now;
      session.lastStressNudgeKind = stressNudge.kind as StressNudgeKind;
      nudge = stressNudge;
    }
  }

  return { presence: session.presence, nudge, watching_note: watchingNote(session.presence) };
}
