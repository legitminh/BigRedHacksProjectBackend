import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadConfig } from "../src/config.ts";
import type { Mailer } from "../src/mailer.ts";
import { createApp } from "../src/server.ts";
import { openFileStore } from "../src/store/file.ts";

const SECRET = "0123456789abcdef0123456789abcdef";

async function withApp(
  fn: (base: string, token: string) => Promise<void>,
  opts?: {
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
    now: () => new Date("2026-10-03T18:00:00.000Z"),
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

test("POST /v1/camera/observe maps null Presage vitals to away after confirm", async () => {
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
      }),
    },
  );
});
