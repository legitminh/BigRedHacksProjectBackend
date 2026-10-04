import assert from "node:assert/strict";
import test from "node:test";

import {
  mapStressedToNudge,
  observePresence,
  shouldSuggestBreak,
  STRESS_COOLDOWN_MS,
  SUGGEST_BREAK_KIND,
  STRESSED_BREATH_KIND,
} from "../src/camera/presence.ts";
import { CameraSessionStore } from "../src/camera/sessionStore.ts";

function at(ms: number): Date {
  return new Date(ms);
}

test("ignores brief away; confirms left_frame after persistence", () => {
  const store = new CameraSessionStore();
  const t0 = 1_000_000;
  const first = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0),
  });
  assert.equal(first.presence, "uncertain");
  assert.equal(first.nudge, null);

  const second = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0 + 1000),
  });
  assert.equal(second.presence, "left_frame");
  assert.equal(second.nudge, null);
});

test("absence ladder then quiet; silent on break and paused", () => {
  const store = new CameraSessionStore();
  const t0 = 2_000_000;
  // Confirm leave (dense ticks — candidate clock starts at t0)
  observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0),
  });
  observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0 + 1000),
  });

  const first = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0 + 25_000),
  });
  assert.equal(first.nudge?.kind, "left_desk");
  assert.match(first.nudge!.text, /stepped away/i);

  const onBreak = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "break",
    faceDetected: false,
    now: at(t0 + 70_000),
  });
  assert.equal(onBreak.nudge, null);

  const onPaused = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "paused",
    faceDetected: false,
    now: at(t0 + 70_000),
  });
  assert.equal(onPaused.nudge, null);

  const second = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0 + 70_000),
  });
  assert.equal(second.nudge?.kind, "left_desk");
  assert.match(second.nudge!.text, /still away/i);

  const pause = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0 + 130_000),
  });
  assert.equal(pause.nudge?.kind, "left_desk_pause");
  assert.match(pause.nudge!.text, /pause check-ins|stay quiet/i);
  assert.ok(!/left_desk/i.test(pause.nudge!.text), "kind tag must not be spoken");

  const quiet = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0 + 200_000),
  });
  assert.equal(quiet.nudge, null);
});

test("30s observe cadence: first left_desk on confirming away (~30s), not an extra period later", () => {
  const store = new CameraSessionStore();
  const t0 = 2_500_000;
  const cadence = 30_000;

  const glance = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0),
  });
  assert.equal(glance.presence, "uncertain");
  assert.equal(glance.nudge, null);

  // Second observe ~30s later: sustained away — confirm + first ladder rung.
  const first = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0 + cadence),
  });
  assert.equal(first.presence, "left_frame");
  assert.equal(first.nudge?.kind, "left_desk");
  assert.match(first.nudge!.text, /stepped away/i);

  // Next tick (~60s total away): second rung, not a repeat of first.
  const second = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0 + 2 * cadence),
  });
  assert.equal(second.nudge?.kind, "left_desk");
  assert.match(second.nudge!.text, /still away/i);

  // ~120s total away: pause ack, then quiet.
  const pauseAck = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0 + 4 * cadence),
  });
  assert.equal(pauseAck.nudge?.kind, "left_desk_pause");

  const quiet = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0 + 5 * cadence),
  });
  assert.equal(quiet.nudge, null);
});

test("single away observe never ladders even if wall clock later advances alone", () => {
  const store = new CameraSessionStore();
  const t0 = 2_700_000;
  const one = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0),
  });
  assert.equal(one.presence, "uncertain");
  assert.equal(one.nudge, null);

  // Present before a second away observe — glance, not a leave.
  const back = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: true,
    now: at(t0 + 30_000),
  });
  assert.equal(back.presence, "present");
  assert.equal(back.nudge, null);
});

test("welcome back once after confirmed return", () => {
  const store = new CameraSessionStore();
  const t0 = 3_000_000;
  observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0),
  });
  observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0 + 1000),
  });

  const back1 = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: true,
    now: at(t0 + 5000),
  });
  assert.equal(back1.nudge, null);

  const back2 = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: true,
    now: at(t0 + 7500),
  });
  assert.equal(back2.nudge?.kind, "welcome_back");

  const again = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: true,
    now: at(t0 + 10_000),
  });
  assert.equal(again.nudge, null);
});

test("stress prefers suggest_break; breath fallback after cooldown; no biometric digits", () => {
  const store = new CameraSessionStore();
  const t0 = 4_000_000;
  const a = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: true,
    stressed: true,
    now: at(t0),
  });
  assert.equal(a.nudge?.kind, SUGGEST_BREAK_KIND);
  assert.match(a.nudge!.text, /optional five-minute break/i);
  // Copy may say "five" in words; never surface numeric vitals (HR/RR/%).
  assert.ok(!/\d/.test(a.nudge!.text));

  const b = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: true,
    stressed: true,
    now: at(t0 + 60_000),
  });
  assert.equal(b.nudge, null);

  const c = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: true,
    stressed: true,
    now: at(t0 + STRESS_COOLDOWN_MS + 1_000),
  });
  assert.equal(c.nudge?.kind, STRESSED_BREATH_KIND);
  assert.match(c.nudge!.text, /slow breath/i);
  assert.ok(!/\d/.test(c.nudge!.text));

  const d = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: true,
    stressed: true,
    now: at(t0 + 2 * STRESS_COOLDOWN_MS + 2_000),
  });
  assert.equal(d.nudge?.kind, SUGGEST_BREAK_KIND);
});

test("stress nudges stay silent on break and paused phases", () => {
  const store = new CameraSessionStore();
  const t0 = 4_500_000;
  for (const phase of ["break", "paused"] as const) {
    const out = observePresence(store, {
      userId: "u",
      sessionId: `s-${phase}`,
      phase,
      faceDetected: true,
      stressed: true,
      now: at(t0),
    });
    assert.equal(out.nudge, null, `expected silence on phase=${phase}`);
  }
});

test("after break phase, stress stays quiet until cooldown grace elapses", () => {
  const store = new CameraSessionStore();
  const t0 = 4_700_000;
  const first = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: true,
    stressed: true,
    now: at(t0),
  });
  assert.equal(first.nudge?.kind, SUGGEST_BREAK_KIND);

  // Five-minute break with observes (desktop keeps uploading) — must stay silent.
  const midBreak = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "break",
    faceDetected: true,
    stressed: true,
    now: at(t0 + 300_000),
  });
  assert.equal(midBreak.nudge, null);

  // Immediately back to active: grace from last quiet observe, not another stress line.
  const resume = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: true,
    stressed: true,
    now: at(t0 + 301_000),
  });
  assert.equal(resume.nudge, null);

  // After full cooldown from last quiet tick, breath fallback (last kind was suggest_break).
  const later = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: true,
    stressed: true,
    now: at(t0 + 301_000 + STRESS_COOLDOWN_MS + 1_000),
  });
  assert.equal(later.nudge?.kind, STRESSED_BREATH_KIND);
});

test("shouldSuggestBreak / mapStressedToNudge helpers", () => {
  assert.equal(shouldSuggestBreak(null), true);
  assert.equal(shouldSuggestBreak(STRESSED_BREATH_KIND), true);
  assert.equal(shouldSuggestBreak(SUGGEST_BREAK_KIND), false);

  const breakNudge = mapStressedToNudge({
    stressed: true,
    silentPhase: false,
    msSinceLastStressNudge: 200_000,
    lastStressKind: null,
  });
  assert.equal(breakNudge?.kind, SUGGEST_BREAK_KIND);
  assert.match(breakNudge!.text, /optional five-minute break/i);
  assert.ok(!/\d/.test(breakNudge!.text));

  assert.equal(
    mapStressedToNudge({
      stressed: true,
      silentPhase: false,
      msSinceLastStressNudge: 200_000,
      lastStressKind: SUGGEST_BREAK_KIND,
    })?.kind,
    STRESSED_BREATH_KIND,
  );
  assert.equal(
    mapStressedToNudge({
      stressed: true,
      silentPhase: true,
      msSinceLastStressNudge: 200_000,
      lastStressKind: null,
    }),
    null,
  );
  assert.equal(
    mapStressedToNudge({
      stressed: true,
      silentPhase: false,
      msSinceLastStressNudge: 10_000,
      lastStressKind: null,
    }),
    null,
  );
  assert.equal(
    mapStressedToNudge({
      stressed: false,
      silentPhase: false,
      msSinceLastStressNudge: 200_000,
      lastStressKind: null,
    }),
    null,
  );
  assert.equal(
    mapStressedToNudge({
      stressed: null,
      silentPhase: false,
      msSinceLastStressNudge: 200_000,
      lastStressKind: null,
    }),
    null,
  );
});

test("false return: brief appearance then away resets return confirmation timer", () => {
  const store = new CameraSessionStore();
  const t0 = 5_000_000;
  // Confirm leave
  observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0),
  });
  observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0 + 1000),
  });

  // Brief appearance (only 1 tick, < RETURN_CONFIRM_MS)
  const flash = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: true,
    now: at(t0 + 5000),
  });
  assert.equal(flash.nudge, null);

  // Steps away again and confirms left_frame
  observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0 + 6000),
  });
  const reConfirmAway = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0 + 7000),
  });
  assert.equal(reConfirmAway.presence, "left_frame");

  // Appears again later: should NOT immediately welcome back from stale presentSince
  const firstTickBack = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: true,
    now: at(t0 + 20_000),
  });
  assert.equal(firstTickBack.nudge, null);

  // Confirmed return after continuous presence
  const confirmedBack = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: true,
    now: at(t0 + 22_500),
  });
  assert.equal(confirmedBack.nudge?.kind, "welcome_back");
});

test("obstructed camera line fires after held delay with helpful non-shaming line", () => {
  const store = new CameraSessionStore();
  const t0 = 6_000_000;
  const start = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: true,
    brightness: 10,
    now: at(t0),
  });
  assert.equal(start.presence, "camera_obstructed");
  assert.equal(start.nudge, null);

  const held = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: true,
    brightness: 10,
    now: at(t0 + 31_000),
  });
  assert.equal(held.nudge?.kind, "camera_obstructed");
  assert.match(held.nudge!.text, /check the camera or lighting/i);
});

