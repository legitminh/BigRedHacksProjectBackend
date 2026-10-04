import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { vitalsFromResult } from "../src/camera/presage.ts";
import { STRESS_COOLDOWN_MS } from "../src/camera/presence.ts";
import { loadConfig } from "../src/config.ts";
import type { Mailer } from "../src/mailer.ts";
import { DEFAULT_RATE_RULES } from "../src/security/rateLimit.ts";
import { createApp } from "../src/server.ts";
import { openFileStore } from "../src/store/file.ts";

const SECRET = "0123456789abcdef0123456789abcdef";

async function withApp(
  fn: (base: string, token: string) => Promise<void>,
  opts?: {
    now?: () => Date;
    rateRules?: Partial<typeof DEFAULT_RATE_RULES>;
    cameraAnalyze?: (
      apiKey: string,
      bytes: Buffer,
      mime: string,
    ) => Promise<{
      heart_rate: number | null;
      breathing_rate: number | null;
      stress_index: number | null;
      stressed: boolean;
      focus_ok: boolean;
      source: "presage";
      raw_summary: string;
      face_detected?: boolean | null;
    }>;
  },
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "waypoint-camera-"));
  const sent: { code: string }[] = [];
  const mailer: Mailer = {
    async sendLoginCode(message) {
      sent.push({ code: message.code });
    },
  };
  const server: Server = createApp({
    config: loadConfig({
      GOOGLE_CLIENT_ID: "client-id",
      GOOGLE_CLIENT_SECRET: "client-secret",
      SESSION_SECRET: SECRET,
      PUBLIC_BASE_URL: "http://127.0.0.1:8787",
      PRESAGE_API_KEY: "test-presage",
    }),
    store: openFileStore(join(dir, "store.json")),
    mailer,
    now: opts?.now ?? (() => new Date("2026-10-03T18:00:00.000Z")),
    rateRules: opts?.rateRules,
    cameraAnalyze: opts?.cameraAnalyze,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await fetch(`${base}/v1/auth/email/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "cam@example.com" }),
    });
    const verify = await fetch(`${base}/v1/auth/email/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "cam@example.com", code: sent[0]!.code }),
    });
    assert.equal(verify.status, 200);
    const auth = (await verify.json()) as { access_token: string };
    await fn(base, auth.access_token);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("POST /v1/camera/observe requires auth", async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/v1/camera/observe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "s1",
        phase: "active",
        mime: "video/mp4",
        data_base64: Buffer.from("fake").toString("base64"),
      }),
    });
    assert.equal(res.status, 401);
  });
});

test("POST /v1/camera/observe returns contract with mocked Presage", async () => {
  await withApp(
    async (base, token) => {
      const res = await fetch(`${base}/v1/camera/observe`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          session_id: "lock-1",
          phase: "active",
          mime: "video/mp4",
          data_base64: Buffer.from("clip-bytes").toString("base64"),
        }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        ok: boolean;
        presence: string;
        face_detected: boolean | null;
        vitals: { heart_rate: number | null; source: string } | null;
        watching_note: string;
      };
      assert.equal(body.ok, true);
      assert.equal(body.face_detected, true);
      assert.equal(body.vitals?.heart_rate, 72);
      assert.equal(body.vitals?.source, "presage");
      assert.match(body.watching_note, /Camera accountability/);
    },
    {
      cameraAnalyze: async () => ({
        heart_rate: 72,
        breathing_rate: 14,
        stress_index: 40,
        stressed: false,
        focus_ok: true,
        source: "presage",
        raw_summary: "ok",
      }),
    },
  );
});

test("POST /v1/camera/observe returns suggest_break nudge when stressed", async () => {
  await withApp(
    async (base, token) => {
      const res = await fetch(`${base}/v1/camera/observe`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          session_id: "lock-stress",
          phase: "active",
          mime: "video/mp4",
          data_base64: Buffer.from("clip-bytes").toString("base64"),
        }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        ok: boolean;
        presence: string;
        vitals: { stressed: boolean } | null;
        nudge: { kind: string; text: string } | null;
      };
      assert.equal(body.ok, true);
      assert.equal(body.presence, "present");
      assert.equal(body.vitals?.stressed, true);
      assert.equal(body.nudge?.kind, "suggest_break");
      assert.match(body.nudge!.text, /optional five-minute break/i);
      assert.ok(!/\d/.test(body.nudge!.text));
    },
    {
      cameraAnalyze: async () => ({
        heart_rate: 88,
        breathing_rate: 18,
        stress_index: 200,
        stressed: true,
        focus_ok: false,
        source: "presage",
        raw_summary: "stressed",
      }),
    },
  );
});

test("POST /v1/camera/observe stays silent on break and paused (no Presage upload)", async () => {
  let analyzeCalls = 0;
  await withApp(
    async (base, token) => {
      for (const phase of ["break", "paused"] as const) {
        const res = await fetch(`${base}/v1/camera/observe`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            session_id: `lock-${phase}-stress`,
            phase,
            mime: "video/mp4",
            data_base64: Buffer.from("clip-bytes").toString("base64"),
          }),
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as {
          vitals: { stressed: boolean } | null;
          nudge: { kind: string; text: string } | null;
          watching_note: string;
        };
        assert.equal(body.vitals, null);
        assert.equal(body.nudge, null, `expected silence on phase=${phase}`);
        assert.match(body.watching_note, /skipped during pause\/break/i);
      }
      assert.equal(analyzeCalls, 0);
    },
    {
      cameraAnalyze: async () => {
        analyzeCalls += 1;
        return {
          heart_rate: 88,
          breathing_rate: 18,
          stress_index: 200,
          stressed: true,
          focus_ok: false,
          source: "presage",
          raw_summary: "stressed",
        };
      },
    },
  );
});

test("POST /v1/camera/observe maps Presage stress-only payload to suggest_break", async () => {
  await withApp(
    async (base, token) => {
      const res = await fetch(`${base}/v1/camera/observe`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          session_id: "lock-stress-only",
          phase: "active",
          mime: "video/webm",
          data_base64: Buffer.from("clip-bytes").toString("base64"),
        }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        presence: string;
        face_detected: boolean | null;
        vitals: { stressed: boolean; stress_index: number | null } | null;
        nudge: { kind: string; text: string } | null;
      };
      assert.equal(body.face_detected, true);
      assert.equal(body.presence, "present");
      assert.equal(body.vitals?.stressed, true);
      assert.equal(body.vitals?.stress_index, 200);
      assert.equal(body.nudge?.kind, "suggest_break");
      assert.match(body.nudge!.text, /five-minute/i);
      assert.ok(!/\d/.test(body.nudge!.text));
    },
    {
      // Real vitalsFromResult path (not a hand-built stressed flag).
      cameraAnalyze: async () => vitalsFromResult({ baevsky_stress_index: 200 }),
    },
  );
});

test("POST /v1/camera/observe HRV-only stress stays present (not away ladder)", async () => {
  await withApp(
    async (base, token) => {
      const res = await fetch(`${base}/v1/camera/observe`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          session_id: "lock-hrv-only",
          phase: "active",
          mime: "video/mp4",
          data_base64: Buffer.from("clip-bytes").toString("base64"),
        }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        presence: string;
        face_detected: boolean | null;
        vitals: {
          heart_rate: number | null;
          stressed: boolean;
          stress_index: number | null;
        } | null;
        nudge: { kind: string; text: string } | null;
      };
      assert.equal(body.face_detected, true);
      assert.equal(body.presence, "present");
      assert.equal(body.vitals?.heart_rate, null);
      assert.equal(body.vitals?.stress_index, null);
      assert.equal(body.vitals?.stressed, true);
      assert.equal(body.nudge?.kind, "suggest_break");
      assert.ok(!/\d/.test(body.nudge!.text));
    },
    {
      cameraAnalyze: async () => vitalsFromResult({ hrv_rmssd: 10 }),
    },
  );
});

test("POST /v1/camera/observe alternates stressed breath after cooldown", async () => {
  let nowMs = Date.parse("2026-10-03T18:00:00.000Z");
  await withApp(
    async (base, token) => {
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      };
      const payload = {
        session_id: "lock-stress-alt",
        phase: "active",
        mime: "video/mp4",
        data_base64: Buffer.from("clip-bytes").toString("base64"),
      };

      const first = await fetch(`${base}/v1/camera/observe`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      assert.equal(first.status, 200);
      const firstBody = (await first.json()) as {
        nudge: { kind: string; text: string } | null;
      };
      assert.equal(firstBody.nudge?.kind, "suggest_break");

      nowMs += 60_000;
      const cooled = await fetch(`${base}/v1/camera/observe`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      assert.equal(cooled.status, 200);
      const cooledBody = (await cooled.json()) as { nudge: unknown };
      assert.equal(cooledBody.nudge, null);

      nowMs += STRESS_COOLDOWN_MS;
      const breath = await fetch(`${base}/v1/camera/observe`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      assert.equal(breath.status, 200);
      const breathBody = (await breath.json()) as {
        nudge: { kind: string; text: string } | null;
      };
      assert.equal(breathBody.nudge?.kind, "stressed");
      assert.match(breathBody.nudge!.text, /slow breath/i);
      assert.ok(!/\d/.test(breathBody.nudge!.text));
    },
    {
      now: () => new Date(nowMs),
      cameraAnalyze: async () => vitalsFromResult({ hr: 90, stress_index: 180 }),
    },
  );
});

test("POST /v1/camera/observe rate limit allows ~25s desktop cadence", async () => {
  let nowMs = Date.parse("2026-10-03T19:00:00.000Z");
  await withApp(
    async (base, token) => {
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      };
      const hit = () =>
        fetch(`${base}/v1/camera/observe`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            session_id: "lock-rate",
            phase: "active",
            mime: "video/mp4",
            data_base64: Buffer.from("clip").toString("base64"),
          }),
        });

      // Default rule: 3 / 75s ≈ 25s floor. Three hits at t=0,25s,50s must succeed;
      // a fourth inside the same window is 429 (do not advance to the reset edge).
      for (let i = 0; i < 3; i += 1) {
        const res = await hit();
        assert.equal(res.status, 200, `hit ${i + 1} should pass at +${i * 25}s`);
        if (i < 2) nowMs += 25_000;
      }
      const blocked = await hit();
      assert.equal(blocked.status, 429);
    },
    {
      now: () => new Date(nowMs),
      cameraAnalyze: async () => ({
        heart_rate: 72,
        breathing_rate: 14,
        stress_index: 40,
        stressed: false,
        focus_ok: true,
        source: "presage",
        raw_summary: "ok",
      }),
    },
  );
});

test("POST /v1/camera/observe Presage failure yields null vitals and stays uncertain", async () => {
  await withApp(
    async (base, token) => {
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      };
      const payload = {
        session_id: "lock-presage-fail",
        phase: "active",
        mime: "video/mp4",
        data_base64: Buffer.from("clip-bytes").toString("base64"),
      };
      const res = await fetch(`${base}/v1/camera/observe`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        vitals: unknown;
        nudge: unknown;
        presence: string;
        face_detected: boolean | null;
      };
      assert.equal(body.vitals, null);
      assert.equal(body.nudge, null);
      // API/transport failures must not mark the student away.
      assert.equal(body.face_detected, null);
      assert.equal(body.presence, "uncertain");

      const second = await fetch(`${base}/v1/camera/observe`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      assert.equal(second.status, 200);
      const secondBody = (await second.json()) as {
        presence: string;
        face_detected: boolean | null;
        vitals: unknown;
      };
      assert.equal(secondBody.face_detected, null);
      assert.equal(secondBody.presence, "uncertain");
      assert.equal(secondBody.vitals, null);
    },
    {
      cameraAnalyze: async () => {
        throw new Error("Presage retrieve timeout");
      },
    },
  );
});

test("POST /v1/camera/observe keeps empty Presage success uncertain (not away)", async () => {
  await withApp(
    async (base, token) => {
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      };
      const payload = {
        session_id: "lock-empty",
        phase: "active",
        mime: "video/mp4",
        data_base64: Buffer.from("clip-bytes").toString("base64"),
      };
      const first = await fetch(`${base}/v1/camera/observe`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      assert.equal(first.status, 200);
      const firstBody = (await first.json()) as {
        face_detected: boolean | null;
        presence: string;
      };
      assert.equal(firstBody.face_detected, null);
      assert.equal(firstBody.presence, "uncertain");

      const second = await fetch(`${base}/v1/camera/observe`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      assert.equal(second.status, 200);
      const secondBody = (await second.json()) as {
        face_detected: boolean | null;
        presence: string;
      };
      assert.equal(secondBody.face_detected, null);
      assert.equal(secondBody.presence, "uncertain");
    },
    {
      cameraAnalyze: async () => ({
        heart_rate: null,
        breathing_rate: null,
        stress_index: null,
        stressed: false,
        focus_ok: false,
        source: "presage",
        raw_summary: "HR=null RR=null",
      }),
    },
  );
});

test("POST /v1/camera/observe ladders away on explicit vendor no-face", async () => {
  await withApp(
    async (base, token) => {
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      };
      const payload = {
        session_id: "lock-away",
        phase: "active",
        mime: "video/mp4",
        data_base64: Buffer.from("clip-bytes").toString("base64"),
      };
      const first = await fetch(`${base}/v1/camera/observe`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      assert.equal(first.status, 200);
      const firstBody = (await first.json()) as {
        face_detected: boolean | null;
        presence: string;
      };
      assert.equal(firstBody.face_detected, false);
      assert.equal(firstBody.presence, "uncertain");

      const second = await fetch(`${base}/v1/camera/observe`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      assert.equal(second.status, 200);
      const secondBody = (await second.json()) as { presence: string };
      assert.equal(secondBody.presence, "left_frame");
    },
    {
      cameraAnalyze: async () => ({
        heart_rate: null,
        breathing_rate: null,
        stress_index: null,
        stressed: false,
        focus_ok: false,
        source: "presage",
        raw_summary: "HR=null RR=null",
        face_detected: false,
      }),
    },
  );
});

test("POST /v1/camera/observe JPEG skips Presage and notes leave unavailable", async () => {
  await withApp(async (base, token) => {
    const res = await fetch(`${base}/v1/camera/observe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        session_id: "jpeg-1",
        phase: "active",
        mime: "image/jpeg",
        data_base64: Buffer.from("jpeg-bytes").toString("base64"),
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      face_detected: boolean | null;
      vitals: null;
      watching_note: string;
      presence: string;
    };
    assert.equal(body.face_detected, null);
    assert.equal(body.vitals, null);
    assert.equal(body.presence, "uncertain");
    assert.match(body.watching_note, /JPEG observe skips Presage/i);
  });
});

test("POST /v1/camera/observe skips Presage upload during break", async () => {
  let analyzeCalls = 0;
  await withApp(
    async (base, token) => {
      const res = await fetch(`${base}/v1/camera/observe`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          session_id: "break-1",
          phase: "break",
          mime: "video/mp4",
          data_base64: Buffer.from("clip-bytes").toString("base64"),
        }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { vitals: null; watching_note: string };
      assert.equal(body.vitals, null);
      assert.equal(analyzeCalls, 0);
      assert.match(body.watching_note, /skipped during pause\/break/i);
    },
    {
      cameraAnalyze: async () => {
        analyzeCalls += 1;
        return {
          heart_rate: 70,
          breathing_rate: 14,
          stress_index: 40,
          stressed: false,
          focus_ok: true,
          source: "presage",
          raw_summary: "ok",
        };
      },
    },
  );
});

test("POST /v1/camera/observe local face false + empty Presage confirms away", async () => {
  await withApp(
    async (base, token) => {
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      };
      const payload = {
        session_id: "lock-local-away",
        phase: "active",
        mime: "video/mp4",
        data_base64: Buffer.from("clip-bytes").toString("base64"),
        client_meta: {
          brightness: 120,
          brightness_measured: true,
          face_detected: false,
          attention: "absent",
        },
      };
      const first = await fetch(`${base}/v1/camera/observe`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      assert.equal(first.status, 200);
      const firstBody = (await first.json()) as {
        face_detected: boolean | null;
        presence: string;
      };
      // Empty Presage must not block local-away (first tick still confirms).
      assert.equal(firstBody.face_detected, false);
      assert.equal(firstBody.presence, "uncertain");

      const second = await fetch(`${base}/v1/camera/observe`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      assert.equal(second.status, 200);
      const secondBody = (await second.json()) as {
        face_detected: boolean | null;
        presence: string;
      };
      assert.equal(secondBody.face_detected, false);
      assert.equal(secondBody.presence, "left_frame");
    },
    {
      cameraAnalyze: async () => ({
        heart_rate: null,
        breathing_rate: null,
        stress_index: null,
        stressed: false,
        focus_ok: false,
        source: "presage",
        raw_summary: "HR=null RR=null",
      }),
    },
  );
});

test("POST /v1/camera/observe Presage timeout still uses local face away", async () => {
  await withApp(
    async (base, token) => {
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      };
      const payload = {
        session_id: "lock-local-timeout-away",
        phase: "active",
        mime: "video/mp4",
        data_base64: Buffer.from("clip-bytes").toString("base64"),
        client_meta: {
          face_detected: false,
          attention: "absent",
          brightness: 100,
          brightness_measured: true,
        },
      };
      const first = await fetch(`${base}/v1/camera/observe`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      assert.equal(first.status, 200);
      const firstBody = (await first.json()) as {
        face_detected: boolean | null;
        vitals: unknown;
        presence: string;
      };
      assert.equal(firstBody.vitals, null);
      assert.equal(firstBody.face_detected, false);
      assert.equal(firstBody.presence, "uncertain");

      const second = await fetch(`${base}/v1/camera/observe`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      assert.equal(second.status, 200);
      const secondBody = (await second.json()) as { presence: string };
      assert.equal(secondBody.presence, "left_frame");
    },
    {
      cameraAnalyze: async () => {
        throw new Error("Presage retrieve timeout");
      },
    },
  );
});

test("POST /v1/camera/observe Presage explicit false wins when no local face", async () => {
  await withApp(
    async (base, token) => {
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      };
      const payload = {
        session_id: "lock-presage-explicit-no-local",
        phase: "active",
        mime: "video/mp4",
        data_base64: Buffer.from("clip-bytes").toString("base64"),
        client_meta: { brightness: 110, brightness_measured: true },
      };
      const first = await fetch(`${base}/v1/camera/observe`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      assert.equal(first.status, 200);
      const firstBody = (await first.json()) as {
        face_detected: boolean | null;
        presence: string;
      };
      assert.equal(firstBody.face_detected, false);
      assert.equal(firstBody.presence, "uncertain");

      const second = await fetch(`${base}/v1/camera/observe`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      assert.equal(second.status, 200);
      const secondBody = (await second.json()) as { presence: string };
      assert.equal(secondBody.presence, "left_frame");
    },
    {
      cameraAnalyze: async () => ({
        heart_rate: null,
        breathing_rate: null,
        stress_index: null,
        stressed: false,
        focus_ok: false,
        source: "presage",
        raw_summary: "no face",
        face_detected: false,
      }),
    },
  );
});

test("POST /v1/camera/observe local face true + Presage null stays present", async () => {
  await withApp(
    async (base, token) => {
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      };
      const payload = {
        session_id: "lock-local-present",
        phase: "active",
        mime: "video/mp4",
        data_base64: Buffer.from("clip-bytes").toString("base64"),
        client_meta: {
          brightness: 140,
          brightness_measured: true,
          face_detected: true,
          attention: "present",
        },
      };
      const first = await fetch(`${base}/v1/camera/observe`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      assert.equal(first.status, 200);
      const firstBody = (await first.json()) as {
        face_detected: boolean | null;
        presence: string;
      };
      assert.equal(firstBody.face_detected, true);
      assert.equal(firstBody.presence, "present");

      const second = await fetch(`${base}/v1/camera/observe`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      assert.equal(second.status, 200);
      const secondBody = (await second.json()) as {
        face_detected: boolean | null;
        presence: string;
      };
      assert.equal(secondBody.face_detected, true);
      assert.equal(secondBody.presence, "present");
    },
    {
      cameraAnalyze: async () => ({
        heart_rate: null,
        breathing_rate: null,
        stress_index: null,
        stressed: false,
        focus_ok: false,
        source: "presage",
        raw_summary: "empty",
      }),
    },
  );
});

test("POST /v1/camera/observe local face preferred over Presage scalars", async () => {
  await withApp(
    async (base, token) => {
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      };
      const payload = {
        session_id: "lock-local-primary",
        phase: "active",
        mime: "video/mp4",
        data_base64: Buffer.from("clip-bytes").toString("base64"),
        client_meta: {
          face_detected: false,
          attention: "absent",
          brightness: 90,
          brightness_measured: true,
        },
      };
      const first = await fetch(`${base}/v1/camera/observe`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      assert.equal(first.status, 200);
      const firstBody = (await first.json()) as {
        face_detected: boolean | null;
        presence: string;
        vitals: { heart_rate: number | null } | null;
      };
      // Local face posted → Presage skipped (no 45s rPPG block); vitals stay null.
      // Presence still uses local away (PRIMARY) even if analyze would have returned HR.
      assert.equal(firstBody.vitals, null);
      assert.equal(firstBody.face_detected, false);
      assert.equal(firstBody.presence, "uncertain");

      const second = await fetch(`${base}/v1/camera/observe`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      assert.equal(second.status, 200);
      const secondBody = (await second.json()) as { presence: string };
      assert.equal(secondBody.presence, "left_frame");
    },
    {
      // Must not be called when client posts face_detected.
      cameraAnalyze: async () => {
        throw new Error("Presage should be skipped when local face is posted");
      },
    },
  );
});

test("POST /v1/camera/observe passes looking_down attention through", async () => {
  await withApp(
    async (base, token) => {
      const res = await fetch(`${base}/v1/camera/observe`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          session_id: "lock-looking-down",
          phase: "active",
          mime: "video/mp4",
          data_base64: Buffer.from("clip-bytes").toString("base64"),
          client_meta: {
            face_detected: true,
            attention: "looking_down",
            brightness: 130,
            brightness_measured: true,
          },
        }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        face_detected: boolean | null;
        presence: string;
      };
      assert.equal(body.face_detected, true);
      // Face present — looking_down must not become left_frame.
      assert.equal(body.presence, "present");
    },
    {
      cameraAnalyze: async () => ({
        heart_rate: null,
        breathing_rate: null,
        stress_index: null,
        stressed: false,
        focus_ok: false,
        source: "presage",
        raw_summary: "empty",
      }),
    },
  );
});

test("POST /v1/camera/observe looking_away emits look_back nudge", async () => {
  await withApp(
    async (base, token) => {
      const res = await fetch(`${base}/v1/camera/observe`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          session_id: "lock-looking-away",
          phase: "active",
          mime: "video/mp4",
          data_base64: Buffer.from("clip-bytes").toString("base64"),
          client_meta: {
            face_detected: true,
            attention: "looking_away",
            brightness: 130,
            brightness_measured: true,
          },
        }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        face_detected: boolean | null;
        presence: string;
        nudge: { kind: string; text: string } | null;
      };
      assert.equal(body.face_detected, true);
      assert.equal(body.presence, "present");
      assert.equal(body.nudge?.kind, "look_back");
      assert.equal(
        body.nudge!.text,
        "You're looking away. Turn back to the work.",
      );
    },
    {
      cameraAnalyze: async () => ({
        heart_rate: null,
        breathing_rate: null,
        stress_index: null,
        stressed: false,
        focus_ok: false,
        source: "presage",
        raw_summary: "empty",
      }),
    },
  );
});
