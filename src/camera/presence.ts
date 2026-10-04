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

const AWAY_CONFIRM_OBSERVES = 2;
const AWAY_CONFIRM_MS = 5_000;
const LADDER: Array<{ step: LadderStep; afterMs: number; kind: string; text: string }> = [
  {
    step: "first",
    afterMs: 20_000,
    kind: "left_desk",
    text: "You've stepped away. Come back to the work.",
  },
  {
    step: "second",
    afterMs: 60_000,
    kind: "left_desk",
    text: "Still away — pick the task back up when you can.",
  },
  {
    step: "pause",
    afterMs: 120_000,
    kind: "left_desk_pause",
    text: "I'll stay quiet until you're back at the desk.",
  },
];
const OBSTRUCTED_MS = 30_000;
const STRESS_COOLDOWN_MS = 180_000;
const RETURN_CONFIRM_MS = 2_000;

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

/** Apply one camera observe tick; returns at most one short nudge. */
export function observePresence(
  store: CameraSessionStore,
  input: ObservePresenceInput,
): ObservePresenceResult {
  const now = input.now ?? new Date();
  store.prune(now);
  const session = store.getOrCreate(input.userId, input.sessionId, now);
  const silentPhase = input.phase === "paused" || input.phase === "break";

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
        text: "I can't see you clearly. Check the camera or lighting.",
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
      session.absentSince = now;
      session.leftConfirmed = true;
      session.welcomedBack = false;
    }
    session.presentSince = null;
    session.presence = "left_frame";
    const absentMs = now.getTime() - session.absentSince.getTime();

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
        nudge = { kind: "welcome_back", text: "Welcome back. Stay with the work." };
      }
      resetAbsence(session);
    }
  } else {
    session.absentSince = null;
    session.presentSince = null;
  }

  session.presence = "present";

  if (
    !nudge &&
    !silentPhase &&
    input.stressed === true
  ) {
    const last = session.lastStressNudgeAt?.getTime() ?? 0;
    if (now.getTime() - last >= STRESS_COOLDOWN_MS) {
      session.lastStressNudgeAt = now;
      nudge = {
        kind: "stressed",
        text: "You seem tense — one slow breath, then back to it.",
      };
    }
  }

  return { presence: session.presence, nudge, watching_note: watchingNote(session.presence) };
}
