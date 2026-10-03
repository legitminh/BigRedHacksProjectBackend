import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { PublicUser } from "../store/types.ts";

export type PollError = {
  code: string;
  message: string;
};

export type CompletedLogin = {
  token_type: "Bearer";
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: PublicUser;
};

type PendingStatus = "pending" | "exchanging" | "complete" | "error";

type Pending = {
  state: string;
  pollToken: string;
  codeVerifier: string;
  expiresAt: number;
  status: PendingStatus;
  result?: CompletedLogin;
  error?: PollError;
};

export type ClaimResult =
  | { ok: true; pending: Pending }
  | { ok: false; reason: "missing" | "expired" | "used" };

export type PollResult =
  | { type: "missing" }
  | { type: "expired" }
  | { type: "pending"; expiresIn: number }
  | { type: "complete"; result: CompletedLogin }
  | { type: "error"; error: PollError };

type FileShape = { pendings: Pending[] };

/**
 * In-memory Google login polls, optionally mirrored to disk so an API restart
 * mid-browser-consent does not strand a completed OAuth callback.
 */
export class PendingLogins {
  private byState = new Map<string, Pending>();
  private byPoll = new Map<string, Pending>();
  private persistPath: string | null;

  constructor(persistPath: string | null = null) {
    this.persistPath = persistPath;
    if (persistPath) this.load();
  }

  put(pending: Pending): void {
    this.byState.set(pending.state, pending);
    this.byPoll.set(pending.pollToken, pending);
    this.save();
  }

  claim(state: string, now: number): ClaimResult {
    const pending = this.byState.get(state);
    if (!pending) return { ok: false, reason: "missing" };
    if (now >= pending.expiresAt) {
      this.remove(pending);
      return { ok: false, reason: "expired" };
    }
    if (pending.status !== "pending") return { ok: false, reason: "used" };
    // Single-flight: first claimer wins; replays/concurrent callbacks see "used".
    pending.status = "exchanging";
    return { ok: true, pending };
  }

  complete(pending: Pending, result: CompletedLogin): void {
    if (pending.status !== "pending" && pending.status !== "exchanging") return;
    pending.status = "complete";
    pending.result = result;
    this.save();
  }

  fail(pending: Pending, error: PollError): void {
    if (pending.status !== "pending" && pending.status !== "exchanging") return;
    pending.status = "error";
    pending.error = error;
    this.save();
  }

  poll(token: string, now: number): PollResult {
    const pending = this.byPoll.get(token);
    if (!pending) return { type: "missing" };
    if (now >= pending.expiresAt) {
      this.remove(pending);
      return { type: "expired" };
    }
    if (pending.status === "pending" || pending.status === "exchanging") {
      return {
        type: "pending",
        expiresIn: Math.max(0, Math.ceil((pending.expiresAt - now) / 1000)),
      };
    }
    if (pending.status === "complete" && pending.result) {
      const result = pending.result;
      this.remove(pending);
      return { type: "complete", result };
    }
    const error = pending.error ?? {
      code: "google_exchange_failed",
      message: "Google sign-in failed.",
    };
    this.remove(pending);
    return { type: "error", error };
  }

  private remove(pending: Pending): void {
    this.byState.delete(pending.state);
    this.byPoll.delete(pending.pollToken);
    this.save();
  }

  private load(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const raw = readFileSync(this.persistPath, "utf8");
      const parsed = JSON.parse(raw) as FileShape;
      const now = Date.now();
      for (const pending of parsed.pendings ?? []) {
        if (!pending?.state || !pending.pollToken) continue;
        if (now >= pending.expiresAt) continue;
        // Completed results (tokens) are memory-only; exchanging flows cannot resume.
        if (pending.status !== "pending" && pending.status !== "error") continue;
        delete pending.result;
        this.byState.set(pending.state, pending);
        this.byPoll.set(pending.pollToken, pending);
      }
    } catch (error) {
      console.error("Failed to load pending Google logins:", error);
    }
  }

  private save(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true, mode: 0o700 });
      // Never write access/refresh tokens: only in-flight (pending) and error rows, no `result`.
      const body: FileShape = {
        pendings: [...this.byPoll.values()]
          .filter((p) => p.status === "pending" || p.status === "error")
          .map(({ result: _result, ...rest }) => rest),
      };
      const tmp = `${this.persistPath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.persistPath);
    } catch (error) {
      console.error("Failed to persist pending Google logins:", error);
    }
  }
}
