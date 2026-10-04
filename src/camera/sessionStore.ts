/** In-memory camera presence state keyed by userId + sessionId. */

export type PresenceState = "present" | "left_frame" | "uncertain" | "camera_obstructed";

export type LadderStep = "first" | "second" | "pause";

/** Ladder nudge awaiting desktop `client_meta.last_nudge_ack` (F4 speak-ack). */
export type PendingLadderNudge = {
  step: LadderStep;
  kind: string;
  text: string;
  lastEmittedAt: Date;
};

export interface CameraPresenceSession {
  presence: PresenceState;
  /** When consecutive away observations / held time began (pre-confirm). */
  awayCandidateSince: Date | null;
  consecutiveAway: number;
  /** When left_frame was confirmed. */
  absentSince: Date | null;
  /** When continuous presence resumed after absence. */
  presentSince: Date | null;
  /** Ladder steps acked (delivered) this absence — not set until desktop ack. */
  ladderSpoken: Set<LadderStep>;
  linesSpoken: number;
  /** After pause rung is acked, stay quiet on the ladder. */
  ladderQuiet: boolean;
  /**
   * Last ladder nudge emitted but not yet acked by desktop.
   * Re-emitted sparsely until `last_nudge_ack` matches `kind`.
   */
  pendingLadderNudge: PendingLadderNudge | null;
  /** Welcome-back already spoken for this return. */
  welcomedBack: boolean;
  /** Confirmed leave this cycle (eligible for welcome-back). */
  leftConfirmed: boolean;
  obstructedSince: Date | null;
  obstructedSaid: boolean;
  lastStressNudgeAt: Date | null;
  /** Last stress-family nudge kind (`suggest_break` | `stressed`) for alternation. */
  lastStressNudgeKind: "suggest_break" | "stressed" | null;
  /** When consecutive looking_down observations / held time began (pre-confirm). */
  lookingDownCandidateSince: Date | null;
  consecutiveLookingDown: number;
  /** Last look_back nudge (sparse cooldown). */
  lastLookBackNudgeAt: Date | null;
  lastSeenAt: Date;
}

export function sessionKey(userId: string, sessionId: string): string {
  return `${userId}\u0000${sessionId}`;
}

export function createEmptySession(now: Date): CameraPresenceSession {
  return {
    presence: "present",
    awayCandidateSince: null,
    consecutiveAway: 0,
    absentSince: null,
    presentSince: null,
    ladderSpoken: new Set(),
    linesSpoken: 0,
    ladderQuiet: false,
    pendingLadderNudge: null,
    welcomedBack: false,
    leftConfirmed: false,
    obstructedSince: null,
    obstructedSaid: false,
    lastStressNudgeAt: null,
    lastStressNudgeKind: null,
    lookingDownCandidateSince: null,
    consecutiveLookingDown: 0,
    lastLookBackNudgeAt: null,
    lastSeenAt: now,
  };
}

/** Default: drop sessions idle longer than 2 hours. */
export const DEFAULT_SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export class CameraSessionStore {
  private readonly sessions = new Map<string, CameraPresenceSession>();
  /** Per (userId, sessionId) serialize overlapping observe analyzes. */
  private readonly observeGates = new Map<string, Promise<void>>();

  getOrCreate(userId: string, sessionId: string, now: Date = new Date()): CameraPresenceSession {
    const key = sessionKey(userId, sessionId);
    const existing = this.sessions.get(key);
    if (existing) {
      existing.lastSeenAt = now;
      return existing;
    }
    const created = createEmptySession(now);
    this.sessions.set(key, created);
    return created;
  }

  get(userId: string, sessionId: string): CameraPresenceSession | undefined {
    return this.sessions.get(sessionKey(userId, sessionId));
  }

  /**
   * Run `fn` exclusively for this user+session. Concurrent observes wait their turn
   * so presence ladder mutations cannot interleave mid-analyze.
   */
  async withObserveLock<T>(userId: string, sessionId: string, fn: () => Promise<T>): Promise<T> {
    const key = sessionKey(userId, sessionId);
    const previous = this.observeGates.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(
      () => gate,
      () => gate,
    );
    this.observeGates.set(key, chained);
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.observeGates.get(key) === chained) this.observeGates.delete(key);
    }
  }

  size(): number {
    return this.sessions.size;
  }

  /** Remove sessions whose lastSeenAt is older than maxAgeMs. Returns pruned count. */
  prune(now: Date = new Date(), maxAgeMs: number = DEFAULT_SESSION_MAX_AGE_MS): number {
    let removed = 0;
    const cutoff = now.getTime() - maxAgeMs;
    for (const [key, session] of this.sessions) {
      if (session.lastSeenAt.getTime() < cutoff) {
        this.sessions.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    this.sessions.clear();
    this.observeGates.clear();
  }
}
