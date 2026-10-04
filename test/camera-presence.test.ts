import assert from "node:assert/strict";
import test from "node:test";

import { observePresence } from "../src/camera/presence.ts";
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

test("absence ladder then quiet; silent on break", () => {
  const store = new CameraSessionStore();
  const t0 = 2_000_000;
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

  const second = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0 + 70_000),
  });
  assert.equal(second.nudge?.kind, "left_desk");

  const pause = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0 + 130_000),
  });
  assert.equal(pause.nudge?.kind, "left_desk_pause");

  const quiet = observePresence(store, {
    userId: "u",
    sessionId: "s",
    phase: "active",
    faceDetected: false,
    now: at(t0 + 200_000),
  });
  assert.equal(quiet.nudge, null);
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

test("stress cooldown 180s and no HR numbers in line", () => {
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
  assert.equal(a.nudge?.kind, "stressed");
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
    now: at(t0 + 181_000),
  });
  assert.equal(c.nudge?.kind, "stressed");
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

