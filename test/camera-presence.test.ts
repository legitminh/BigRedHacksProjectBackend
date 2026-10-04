import assert from "node:assert/strict";
import test from "node:test";

import {
  mapStressedToNudge,
  observePresence,
  shouldSuggestBreak,
  STRESS_COOLDOWN_MS,
  STRESSED_BREATH_KIND,
  SUGGEST_BREAK_KIND,
} from "../src/camera/presence.ts";
import { CameraSessionStore } from "../src/camera/sessionStore.ts";

function at(ms: number): Date {
  return new Date(ms);
}

test("ignores brief away; confirms left_frame after persistence", () => {
  const store = new CameraSessionStore();
  const t0 = 1_000_000;
  const a = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0),
  });
  assert.equal(a.presence, "uncertain");
  assert.equal(a.nudge, null);

  const b = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0 + 1000),
  });
  assert.equal(b.presence, "left_frame");
  // Under 25s: silent (catalog D1).
  assert.equal(b.nudge, null);
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
  assert.ok(!/phone/i.test(first.nudge!.text), "D1 must not accuse phone without C1 box");

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

  // Before 3 min: no second rung yet.
  const mid = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0 + 70_000),
  });
  assert.equal(mid.nudge, null);

  // ~3 min: optional break invite (catalog D1).
  const breakOffer = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0 + 180_000),
  });
  assert.equal(breakOffer.nudge?.kind, SUGGEST_BREAK_KIND);
  assert.match(breakOffer.nudge!.text, /five-minute break/i);
  assert.ok(!/\d/.test(breakOffer.nudge!.text));

  // ~10 min: quiet ack, then silence.
  const pause = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0 + 600_000),
  });
  assert.equal(pause.nudge?.kind, "left_desk_pause");
  assert.match(pause.nudge!.text, /stay quiet|pause check-ins/i);
  assert.ok(!/left_desk/i.test(pause.nudge!.text), "kind tag must not be spoken");

  const quiet = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0 + 700_000),
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

  // Second observe ~30s later: sustained away — confirm + first ladder rung (≥25s).
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

  // Next ticks before 3 min: no second rung.
  const mid = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0 + 2 * cadence),
  });
  assert.equal(mid.nudge, null);

  // ~3 min total away: break offer.
  const breakOffer = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0 + 6 * cadence),
  });
  assert.equal(breakOffer.nudge?.kind, SUGGEST_BREAK_KIND);

  // ~10 min: pause ack, then quiet.
  const pauseAck = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0 + 20 * cadence),
  });
  assert.equal(pauseAck.nudge?.kind, "left_desk_pause");

  const quiet = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0 + 21 * cadence),
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

test("welcome back once after confirmed return lasting ≥20s away", () => {
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
  // Hold away past welcome threshold + first callback.
  observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0 + 25_000),
  });

  const back1 = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: true,
    now: at(t0 + 30_000),
  });
  assert.equal(back1.nudge, null);

  const back2 = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: true,
    now: at(t0 + 32_500),
  });
  assert.equal(back2.nudge?.kind, "welcome_back");
  assert.match(back2.nudge!.text, /welcome back/i);

  const again = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: true,
    now: at(t0 + 40_000),
  });
  assert.equal(again.nudge, null);
});

test("brief leave under 20s returns silently (catalog D2)", () => {
  const store = new CameraSessionStore();
  const t0 = 3_200_000;
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
  // Confirmed leave but total absent < 20s when return confirms.
  observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: true,
    now: at(t0 + 5_000),
  });
  const back = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: true,
    now: at(t0 + 7_500),
  });
  assert.equal(back.nudge, null);
  assert.equal(back.presence, "present");
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

  // Quiet phase refreshes the stress cooldown clock.
  observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "break",
    faceDetected: true,
    stressed: true,
    now: at(t0 + 10_000),
  });

  const soon = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: true,
    stressed: true,
    now: at(t0 + 20_000),
  });
  assert.equal(soon.nudge, null);

  // After full cooldown from last quiet tick, breath fallback (last kind was suggest_break).
  const later = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: true,
    stressed: true,
    now: at(t0 + 10_000 + STRESS_COOLDOWN_MS + 1_000),
  });
  assert.equal(later.nudge?.kind, STRESSED_BREATH_KIND);
});

test("shouldSuggestBreak / mapStressedToNudge helpers", () => {
  assert.equal(shouldSuggestBreak(null), true);
  assert.equal(shouldSuggestBreak(SUGGEST_BREAK_KIND), false);
  assert.equal(shouldSuggestBreak(STRESSED_BREATH_KIND), true);

  const breakNudge = mapStressedToNudge({
    stressed: true,
    silentPhase: false,
    msSinceLastStressNudge: STRESS_COOLDOWN_MS,
    lastStressKind: null,
  });
  assert.equal(breakNudge?.kind, SUGGEST_BREAK_KIND);

  const breath = mapStressedToNudge({
    stressed: true,
    silentPhase: false,
    msSinceLastStressNudge: STRESS_COOLDOWN_MS,
    lastStressKind: SUGGEST_BREAK_KIND,
  });
  assert.equal(breath?.kind, STRESSED_BREATH_KIND);
  assert.ok(breath && !/\d/.test(breath.text));
});

test("false return: brief appearance then away resets return confirmation timer", () => {
  const store = new CameraSessionStore();
  const t0 = 5_000_000;
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
  observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0 + 25_000),
  });

  observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: true,
    now: at(t0 + 30_000),
  });
  // Glance then leave again before RETURN_CONFIRM_MS — no welcome yet.
  observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0 + 30_500),
  });
  const stillAway = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0 + 31_500),
  });
  assert.equal(stillAway.presence, "left_frame");
  assert.notEqual(stillAway.nudge?.kind, "welcome_back");

  // Sustained return after long absence.
  observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: true,
    now: at(t0 + 40_000),
  });
  const confirmedBack = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: true,
    now: at(t0 + 42_500),
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
    now: at(t0 + 30_000),
  });
  assert.equal(held.nudge?.kind, "camera_obstructed");
  assert.match(held.nudge!.text, /camera|lighting/i);
});
