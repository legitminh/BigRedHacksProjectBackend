import assert from "node:assert/strict";
import test from "node:test";

import {
  LOOK_AWAY_TEXT,
  LOOK_BACK_COOLDOWN_MS,
  LOOK_BACK_KIND,
  mapStressedToNudge,
  NUDGE_REEMIT_MS,
  observePresence,
  PRESENCE_TIMINGS,
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

  // Before 3 min: ack first rung so we do not re-emit; no second rung yet.
  const mid = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    lastNudgeAck: "left_desk",
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
    lastNudgeAck: SUGGEST_BREAK_KIND,
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
    lastNudgeAck: "left_desk_pause",
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

  // Next ticks before 3 min: ack delivery; no second rung.
  const mid = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    lastNudgeAck: "left_desk",
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
    lastNudgeAck: SUGGEST_BREAK_KIND,
    now: at(t0 + 20 * cadence),
  });
  assert.equal(pauseAck.nudge?.kind, "left_desk_pause");

  const quiet = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    lastNudgeAck: "left_desk_pause",
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

test("face present wins over placeholder brightness 0", () => {
  const store = new CameraSessionStore();
  const out = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: true,
    brightness: 0,
    now: at(9_000_000),
  });
  assert.equal(out.presence, "present");
  assert.equal(out.nudge, null);
});

test("observe lock serializes overlapping session work", async () => {
  const store = new CameraSessionStore();
  const order: number[] = [];
  const a = store.withObserveLock("u", "s", async () => {
    order.push(1);
    await new Promise((r) => setTimeout(r, 30));
    order.push(2);
    return "a";
  });
  const b = store.withObserveLock("u", "s", async () => {
    order.push(3);
    return "b";
  });
  assert.deepEqual(await Promise.all([a, b]), ["a", "b"]);
  assert.deepEqual(order, [1, 2, 3]);
});

test("obstructed camera line fires after held delay with helpful non-shaming line", () => {
  const store = new CameraSessionStore();
  const t0 = 6_000_000;
  const start = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: null,
    brightness: 10,
    brightnessMeasured: true,
    now: at(t0),
  });
  assert.equal(start.presence, "camera_obstructed");
  assert.equal(start.nudge, null);

  const held = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: null,
    brightness: 10,
    brightnessMeasured: true,
    now: at(t0 + 8_000),
  });
  assert.equal(held.nudge?.kind, "camera_obstructed");
  assert.match(held.nudge!.text, /camera|lighting/i);
});

test("PRESENCE_TIMINGS mirrors Dhanvi glance / look-away / first_callback", () => {
  assert.equal(PRESENCE_TIMINGS.glanceIgnoreS, 8);
  assert.equal(PRESENCE_TIMINGS.lookUpOrAwayS, 30);
  assert.equal(PRESENCE_TIMINGS.lookAwayConfirmObserves, 1);
  assert.equal(PRESENCE_TIMINGS.lookDownConfirmObserves, 2);
  assert.equal(PRESENCE_TIMINGS.leftFrameFirstCallbackMs, 25_000);
  assert.equal(PRESENCE_TIMINGS.leftFrameFirstCallbackDemoMs, 10_000);
  assert.equal(PRESENCE_TIMINGS.cameraObstructedMs, 8_000);
});

test("looking_away confirms on first observe with look_back", () => {
  const store = new CameraSessionStore();
  const t0 = 7_500_000;
  const away = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: true,
    attention: "looking_away",
    now: at(t0),
  });
  assert.equal(away.presence, "present");
  assert.equal(away.nudge?.kind, LOOK_BACK_KIND);
  assert.equal(away.nudge!.text, LOOK_AWAY_TEXT);
  assert.equal(away.nudge!.text, "You're looking away. Turn back to the work.");
  assert.notEqual(away.nudge?.kind, "left_desk");
});

test("looking_away never becomes left_desk even if faceDetected is false", () => {
  const store = new CameraSessionStore();
  const t0 = 7_600_000;
  const a = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    attention: "looking_away",
    now: at(t0),
  });
  assert.equal(a.presence, "present");
  assert.equal(a.nudge?.kind, LOOK_BACK_KIND);
});

test("looking_down confirms then emits look_back; single glance does not", () => {
  const store = new CameraSessionStore();
  const t0 = 7_000_000;
  const glance = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: true,
    attention: "looking_down",
    now: at(t0),
  });
  assert.equal(glance.presence, "present");
  assert.equal(glance.nudge, null);
  assert.notEqual(glance.nudge?.kind, "left_desk");

  const confirmed = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: true,
    attention: "looking_down",
    now: at(t0 + 1_000),
  });
  assert.equal(confirmed.presence, "present");
  assert.equal(confirmed.nudge?.kind, LOOK_BACK_KIND);
  const wordCount = confirmed.nudge!.text
    .trim()
    .split(/\s+/)
    .filter((w) => /\w/.test(w)).length;
  assert.ok(wordCount <= 12, `look_back copy must stay ≤12 words (got ${wordCount})`);
  assert.match(confirmed.nudge!.text, /eyes on the work/i);
  // Soft hedge only — not a hard phone accusation (needs box detector; Audit E).
  assert.match(confirmed.nudge!.text, /if you're on it/i);
});

test("looking_down never becomes left_desk even if faceDetected is false", () => {
  const store = new CameraSessionStore();
  const t0 = 7_200_000;
  const a = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    attention: "looking_down",
    now: at(t0),
  });
  assert.equal(a.presence, "present");
  assert.notEqual(a.nudge?.kind, "left_desk");

  const b = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    attention: "looking_down",
    now: at(t0 + 1_000),
  });
  assert.equal(b.presence, "present");
  assert.equal(b.nudge?.kind, LOOK_BACK_KIND);
  assert.notEqual(b.nudge?.kind, "left_desk");
});

test("look_back respects sparse cooldown; brief looking_down resets confirm", () => {
  const store = new CameraSessionStore();
  const t0 = 7_400_000;
  observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: true,
    attention: "looking_down",
    now: at(t0),
  });
  const first = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: true,
    attention: "looking_down",
    now: at(t0 + 1_000),
  });
  assert.equal(first.nudge?.kind, LOOK_BACK_KIND);

  const duringCooldown = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: true,
    attention: "looking_down",
    now: at(t0 + 30_000),
  });
  assert.equal(duringCooldown.presence, "present");
  assert.equal(duringCooldown.nudge, null);

  const afterCooldown = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: true,
    attention: "looking_down",
    now: at(t0 + LOOK_BACK_COOLDOWN_MS + 2_000),
  });
  assert.equal(afterCooldown.nudge?.kind, LOOK_BACK_KIND);

  // Eyes up then a single looking_down glance — must re-confirm.
  observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: true,
    attention: "present",
    now: at(t0 + LOOK_BACK_COOLDOWN_MS + 10_000),
  });
  const glance = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: true,
    attention: "looking_down",
    now: at(t0 + LOOK_BACK_COOLDOWN_MS + 11_000),
  });
  assert.equal(glance.nudge, null);
});

test("look_back stays silent on break and paused", () => {
  const store = new CameraSessionStore();
  const t0 = 7_600_000;
  for (const phase of ["break", "paused"] as const) {
    observePresence(store, {
      userId: "u",
      sessionId: `s-${phase}`,
      phase,
      faceDetected: true,
      attention: "looking_down",
      now: at(t0),
    });
    const out = observePresence(store, {
      userId: "u",
      sessionId: `s-${phase}`,
      phase,
      faceDetected: true,
      attention: "looking_down",
      now: at(t0 + 1_000),
    });
    assert.equal(out.presence, "present", `presence present on phase=${phase}`);
    assert.equal(out.nudge, null, `expected silence on phase=${phase}`);
  }
});

test("speak-ack: drop then ack consumes left_desk; ladder can advance", () => {
  const store = new CameraSessionStore();
  const t0 = 8_000_000;
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
    now: at(t0 + 1_000),
  });
  const first = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0 + 25_000),
  });
  assert.equal(first.nudge?.kind, "left_desk");

  // Desktop dropped speak — no ack yet; within re-emit window → quiet.
  const beforeReemit = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0 + 25_000 + NUDGE_REEMIT_MS - 1),
  });
  assert.equal(beforeReemit.nudge, null);

  // Ack arrives → rung consumed; still under 3 min → no next rung.
  const acked = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    lastNudgeAck: "left_desk",
    now: at(t0 + 25_000 + NUDGE_REEMIT_MS + 1_000),
  });
  assert.equal(acked.nudge, null);

  const session = store.get("u", "s");
  assert.ok(session?.ladderSpoken.has("first"));
  assert.equal(session?.pendingLadderNudge, null);

  // After ack, second rung can fire at ~3 min.
  const second = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0 + 180_000),
  });
  assert.equal(second.nudge?.kind, SUGGEST_BREAK_KIND);
});

test("speak-ack: re-emit unacked left_desk sparsely; wrong ack does not consume", () => {
  const store = new CameraSessionStore();
  const t0 = 8_200_000;
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
    now: at(t0 + 1_000),
  });
  const first = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0 + 25_000),
  });
  assert.equal(first.nudge?.kind, "left_desk");

  // Wrong kind must not clear pending.
  const wrongAck = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    lastNudgeAck: "look_back",
    now: at(t0 + 25_000 + 5_000),
  });
  assert.equal(wrongAck.nudge, null);
  assert.ok(store.get("u", "s")?.pendingLadderNudge);

  const reemit = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0 + 25_000 + NUDGE_REEMIT_MS),
  });
  assert.equal(reemit.nudge?.kind, "left_desk");
  assert.match(reemit.nudge!.text, /stepped away/i);

  // Still unacked — must not advance to suggest_break even past 3 min.
  const stuck = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0 + 180_000),
  });
  assert.equal(stuck.nudge?.kind, "left_desk");
  assert.ok(!store.get("u", "s")?.ladderSpoken.has("first"));
});

test("speak-ack: no infinite spam after ack", () => {
  const store = new CameraSessionStore();
  const t0 = 8_400_000;
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
    now: at(t0 + 1_000),
  });
  observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0 + 25_000),
  });

  // Ack on next observe.
  observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    lastNudgeAck: "left_desk",
    now: at(t0 + 26_000),
  });

  // Many later observes before second rung — never re-spam left_desk.
  for (let i = 1; i <= 5; i++) {
    const tick = observePresence(store, {
      userId: "u",
      sessionId: "s",
      phase: "active",
      faceDetected: false,
      lastNudgeAck: "left_desk", // idempotent leftover ack
      now: at(t0 + 26_000 + i * NUDGE_REEMIT_MS),
    });
    assert.equal(tick.nudge, null, `unexpected nudge at tick ${i}`);
  }
});
