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

export type ObservePresenceInput = {
  userId: string;
  sessionId: string;
  phase: CameraPhase;
  faceDetected: boolean | null;
  brightness?: number | null;
  stressed?: boolean | null;
  now?: Date;
};

export type ObservePresenceResult = {
  presence: PresenceState;
  nudge: PresenceNudge | null;
  watching_note: string;
};

/** Need 2 away observes (or held candidate time) so a single glance does not confirm leave. */
const AWAY_CONFIRM_OBSERVES = 2;
/** Time-based confirm when observes are denser than the ~25–30s desktop cadence. */
const AWAY_CONFIRM_MS = 5_000;
/**
 * Absence ladder after left_frame is confirmed (active only).
 * Timings are wall-clock from when the away candidate began (not from confirm tick),
 * so with ~25–30s observe cadence a real away (~20–60s+) gets a first nudge on the
 * confirming observe — not an extra full period later.
 *
 * Kind is an internal tag — spoken `text` is what the student hears. Never surface
 * the kind string in UI/TTS.
 *
 * - `left_desk`: camera confirmed you’re out of frame (not a browser/app).
 * - `left_desk_pause`: still away after ~2 min — stop nagging (does NOT pause the mission).
 * - `welcome_back`: face confirmed back after a leave.
 * - `camera_obstructed`: lens/lighting too dark to judge presence.
 * - `suggest_break` / `stressed`: stress family (present only); break is suggestion-only.
 */
const LADDER: Array<{ step: LadderStep; afterMs: number; kind: string; text: string }> = [
  {
    step: "first",
    afterMs: 20_000,
    kind: "left_desk",
    text: "Looks like you stepped away. Come back when you can.",
  },
  {
    step: "second",
    afterMs: 60_000,
    kind: "left_desk",
    text: "Still away — return to the desk when you're ready.",
  },
  {
    step: "pause",
    afterMs: 120_000,
    kind: "left_desk_pause",
    // Not mission pause — just end the away-nudge ladder for this absence.
    text: "Still away — I'll pause check-ins until you're back.",
  },
];
const OBSTRUCTED_MS = 30_000;
/** Shared cooldown for stress-family nudges (`suggest_break` | `stressed`). */
export const STRESS_COOLDOWN_MS = 180_000;
const RETURN_CONFIRM_MS = 2_000;

// Keep under ~12 words; never include digits (HR/RR/%). Spell out "five".
const SUGGEST_BREAK_TEXT = "Feeling tense — optional five-minute break?";
const STRESSED_BREATH_TEXT = "You seem tense — one slow breath, then back.";
const WELCOME_BACK_TEXT = "Welcome back. Stay with the work.";
const CAMERA_OBSTRUCTED_TEXT =
  "I can't see you clearly. Check the camera or lighting.";

/** Pause and break phases: no spoken nudges. */
export function isSilentCameraPhase(phase: CameraPhase): boolean {
  return phase === "paused" || phase === "break";
}

function classify(
  faceDetected: boolean | null,
  brightness: number | null | undefined,
): PresenceState {
  if (typeof brightness === "number" && brightness < 25) {
    return "camera_obstructed";
  }
  if (faceDetected === true) return "present";
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
  session.leftConfirmed = false;
  session.welcomedBack = false;
  session.presentSince = null;
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

  // Quiet phases: hold the stress cooldown clock so we do not fire a stress
  // line the moment the user leaves break/pause (a five-minute break already
  // outlasts STRESS_COOLDOWN_MS).
  if (silentPhase) {
    session.lastStressNudgeAt = now;
  }

  const raw = classify(input.faceDetected, input.brightness ?? null);

  let nudge: PresenceNudge | null = null;

  if (raw === "camera_obstructed") {
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
    // Ignore brief uncertainty — do not chatter.
    if (session.presence !== "left_frame") {
      session.presence = "uncertain";
    }
    return { presence: session.presence, nudge: null, watching_note: watchingNote(session.presence) };
  }

  if (raw === "left_frame") {
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

    // Quiet on paused/break; after pause-ack stay silent for this absence.
    if (!silentPhase && !session.ladderQuiet) {
      for (const rung of LADDER) {
        if (session.ladderSpoken.has(rung.step) || absentMs < rung.afterMs) continue;
        session.ladderSpoken.add(rung.step);
        session.linesSpoken += 1;
        nudge = { kind: rung.kind, text: rung.text };
        if (rung.step === "pause") session.ladderQuiet = true;
        break;
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
      if (!silentPhase && !session.welcomedBack) {
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
