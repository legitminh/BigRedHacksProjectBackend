import type { PollError } from "../auth/pending.ts";

type Status = "pending" | "exchanging" | "complete" | "error";

type Pending = {
  state: string;
  pollToken: string;
  codeVerifier: string;
  userId: string;
  /** Catalog tool this consent is for. Old records without it are rejected. */
  toolId: string;
  expiresAt: number;
  status: Status;
  error?: PollError;
};

export class CalendarConnects {
  private byState = new Map<string, Pending>();
  private byPoll = new Map<string, Pending>();

  put(pending: Pending): void {
    this.byState.set(pending.state, pending);
    this.byPoll.set(pending.pollToken, pending);
  }

  claim(state: string, now: number): { ok: true; pending: Pending } | { ok: false } {
    const pending = this.byState.get(state);
    if (!pending || now >= pending.expiresAt || pending.status !== "pending") {
      if (pending && now >= pending.expiresAt) this.remove(pending);
      return { ok: false };
    }
    // Single-flight: mark exchanging so replayed/concurrent callbacks are rejected.
    pending.status = "exchanging";
    return { ok: true, pending };
  }

  complete(pending: Pending): void {
    if (pending.status !== "pending" && pending.status !== "exchanging") return;
    pending.status = "complete";
  }

  fail(pending: Pending, error: PollError): void {
    if (pending.status !== "pending" && pending.status !== "exchanging") return;
    pending.status = "error";
    pending.error = error;
  }

  poll(
    token: string,
    now: number,
  ):
    | { type: "missing" }
    | { type: "expired" }
    | { type: "pending"; expiresIn: number }
    | { type: "complete"; toolId: string; userId: string }
    | { type: "error"; error: PollError } {
    const pending = this.byPoll.get(token);
    if (!pending) return { type: "missing" };
    if (now >= pending.expiresAt) {
      this.remove(pending);
      return { type: "expired" };
    }
    if (pending.status === "pending" || pending.status === "exchanging") {
      return { type: "pending", expiresIn: Math.max(0, Math.ceil((pending.expiresAt - now) / 1000)) };
    }
    if (pending.status === "complete") {
      const toolId = pending.toolId;
      const userId = pending.userId;
      this.remove(pending);
      return { type: "complete", toolId, userId };
    }
    const error = pending.error ?? { code: "google_exchange_failed", message: "Calendar connection failed." };
    this.remove(pending);
    return { type: "error", error };
  }

  private remove(pending: Pending): void {
    this.byState.delete(pending.state);
    this.byPoll.delete(pending.pollToken);
  }
}
