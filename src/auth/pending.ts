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

type PendingStatus = "pending" | "complete" | "error";

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

export class PendingLogins {
  private byState = new Map<string, Pending>();
  private byPoll = new Map<string, Pending>();

  put(pending: Pending): void {
    this.byState.set(pending.state, pending);
    this.byPoll.set(pending.pollToken, pending);
  }

  claim(state: string, now: number): ClaimResult {
    const pending = this.byState.get(state);
    if (!pending) return { ok: false, reason: "missing" };
    if (now >= pending.expiresAt) {
      this.remove(pending);
      return { ok: false, reason: "expired" };
    }
    if (pending.status !== "pending") return { ok: false, reason: "used" };
    return { ok: true, pending };
  }

  complete(pending: Pending, result: CompletedLogin): void {
    if (pending.status !== "pending") return;
    pending.status = "complete";
    pending.result = result;
  }

  fail(pending: Pending, error: PollError): void {
    if (pending.status !== "pending") return;
    pending.status = "error";
    pending.error = error;
  }

  poll(token: string, now: number): PollResult {
    const pending = this.byPoll.get(token);
    if (!pending) return { type: "missing" };
    if (now >= pending.expiresAt) {
      this.remove(pending);
      return { type: "expired" };
    }
    if (pending.status === "pending") {
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
  }
}
