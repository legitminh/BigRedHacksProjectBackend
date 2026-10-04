import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertSafePresageUploadUrl,
  HRV_STRESSED_MAX,
  queueVideoHrRr,
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

test("vitalsFromResult ignores error/current collisions for breathing rate", () => {
  assert.equal(vitalsFromResult({ error: 500 }).breathing_rate, null);
  assert.equal(vitalsFromResult({ error_code: 12 }).breathing_rate, null);
  assert.equal(vitalsFromResult({ current: 99 }).breathing_rate, null);
  assert.equal(vitalsFromResult({ br: [12, 14] }).breathing_rate, 14);
  assert.equal(vitalsFromResult({ respiratory_rr: 16 }).breathing_rate, 16);
});

test("vitalsFromResult ignores zero HRV sentinel for stress", () => {
  const v = vitalsFromResult({ hr: 72, hrv: 0 });
  assert.equal(v.stressed, false);
});

test("vitalsFromResult reads explicit face_detected flags", () => {
  assert.equal(vitalsFromResult({ face_detected: false }).face_detected, false);
  assert.equal(vitalsFromResult({ face_present: true, hr: 70 }).face_detected, true);
  assert.equal(vitalsFromResult({}).face_detected, null);
});

test("assertSafePresageUploadUrl rejects SSRF-shaped targets", () => {
  assert.throws(() => assertSafePresageUploadUrl("http://127.0.0.1/evil"), /https/);
  assert.throws(() => assertSafePresageUploadUrl("https://127.0.0.1/evil"), /not allowed/);
  assert.throws(
    () => assertSafePresageUploadUrl("https://169.254.169.254/latest/meta-data/"),
    /not allowed/,
  );
  assert.throws(() => assertSafePresageUploadUrl("https://evil.example.com/put"), /allowlisted/);
  const ok = assertSafePresageUploadUrl(
    "https://presage-uploads.s3.amazonaws.com/part?X-Amz-Signature=abc",
  );
  assert.equal(ok.hostname, "presage-uploads.s3.amazonaws.com");
});

test("queueVideoHrRr refuses incomplete multipart before complete", async () => {
  const calls: string[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/v2/upload-url")) {
      return new Response(
        JSON.stringify({
          id: "vid-1",
          upload_id: "up-1",
          urls: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("unexpected", { status: 500 });
  };
  await assert.rejects(
    () => queueVideoHrRr("key", Buffer.alloc(1024), "video/mp4", { fetchImpl }),
    /no part urls/,
  );
  assert.ok(!calls.some((c) => c.includes("/v2/complete")));
});
