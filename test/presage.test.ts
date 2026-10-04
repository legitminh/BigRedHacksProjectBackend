import assert from "node:assert/strict";
import { test } from "node:test";

import {
  HRV_STRESSED_MAX,
  STRESS_INDEX_STRESSED_MIN,
  vitalsFromResult,
} from "../src/camera/presage.ts";

test("vitalsFromResult marks stressed when stress_index exceeds threshold", () => {
  const v = vitalsFromResult({
    hr: 80,
    br: 14,
    stress_index: STRESS_INDEX_STRESSED_MIN + 1,
  });
  assert.equal(v.stressed, true);
  assert.equal(v.focus_ok, false);
  assert.equal(v.source, "presage");
  assert.equal(v.stress_index, STRESS_INDEX_STRESSED_MIN + 1);
});

test("vitalsFromResult marks stressed when HRV/RMSSD is low", () => {
  const v = vitalsFromResult({
    heart_rate: 70,
    hrv_rmssd: HRV_STRESSED_MAX - 1,
  });
  assert.equal(v.stressed, true);
  assert.equal(v.focus_ok, false);
});

test("vitalsFromResult HRV-only payload does not misread hrv as heart_rate", () => {
  const v = vitalsFromResult({ hrv_rmssd: HRV_STRESSED_MAX - 1 });
  assert.equal(v.heart_rate, null);
  assert.equal(v.breathing_rate, null);
  assert.equal(v.stress_index, null);
  assert.equal(v.stressed, true);
  assert.equal(v.focus_ok, false);
});

test("vitalsFromResult stays calm for mid-range scalars", () => {
  const v = vitalsFromResult({
    hr: 72,
    rr: 14,
    hrv: 42,
    stress_index: 80,
  });
  assert.equal(v.stressed, false);
  assert.equal(v.focus_ok, true);
  assert.equal(v.heart_rate, 72);
  assert.equal(v.breathing_rate, 14);
});

test("vitalsFromResult stress-only payload (no HR/RR) still sets stressed", () => {
  const v = vitalsFromResult({ baevsky_stress_index: 200 });
  assert.equal(v.stressed, true);
  assert.equal(v.heart_rate, null);
  assert.equal(v.breathing_rate, null);
  assert.equal(v.stress_index, 200);
});

test("vitalsFromResult reads last array sample for pulse/breath", () => {
  const v = vitalsFromResult({
    hr: [60, 68, 74],
    br: [12, 13],
    stress: [40, 90],
  });
  assert.equal(v.heart_rate, 74);
  assert.equal(v.breathing_rate, 13);
  assert.equal(v.stress_index, 90);
  assert.equal(v.stressed, false);
});
