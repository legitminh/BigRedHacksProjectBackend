import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";

import { verifyAccessToken } from "../auth/tokens.ts";
import type { CalendarClient } from "../calendar/client.ts";
import type { Config } from "../config.ts";
import type { DriveClient } from "../drive/client.ts";
import type { Store } from "../store/types.ts";
import { runCompanionLiveSession } from "./liveSession.ts";

/** Subprotocol the server selects when offered (keeps the bearer token out of the response). */
export const LIVE_SUBPROTOCOL = "waypoint.live.v1";
const BEARER_PREFIX = "bearer.";

export type LiveLimits = {
  /** Max concurrent Live sessions per user. */
  maxPerUser: number;
  /** Max concurrent Live sessions across all users. */
  maxGlobal: number;
  /** Accept `?access_token=` / `?token=` (deprecated; tokens leak into proxy/access logs). */
  allowQueryToken: boolean;
};

export type LiveUpgradeDeps = {
  config: Config;
  store: Store;
  now: () => Date;
  drive: DriveClient;
  calendar: CalendarClient;
  /** Override env-derived limits (tests). */
  limits?: Partial<LiveLimits>;
};

function nowSeconds(now: Date): number {
  return Math.floor(now.getTime() / 1000);
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

/**
 * Env:
 * - LIVE_MAX_SESSIONS_PER_USER (default 2)
 * - LIVE_MAX_SESSIONS_GLOBAL (default 50)
 * - LIVE_ALLOW_QUERY_TOKEN — deprecated `?access_token=` / `?token=`.
 *   Default off when NODE_ENV=production or PUBLIC_BASE_URL is https (tokens leak into
 *   proxy/CDN logs). Dev HTTP stays on for older clients unless explicitly set to 0.
 */
export function loadLiveLimits(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<LiveLimits> = {},
): LiveLimits {
  const production = (env.NODE_ENV ?? "").trim().toLowerCase() === "production";
  const publicHttps = (env.PUBLIC_BASE_URL ?? "").trim().toLowerCase().startsWith("https://");
  const defaultAllowQuery = !(production || publicHttps);
  return {
    maxPerUser: overrides.maxPerUser ?? positiveInt(env.LIVE_MAX_SESSIONS_PER_USER, 2),
    maxGlobal: overrides.maxGlobal ?? positiveInt(env.LIVE_MAX_SESSIONS_GLOBAL, 50),
    allowQueryToken:
      overrides.allowQueryToken ?? envFlag(env.LIVE_ALLOW_QUERY_TOKEN, defaultAllowQuery),
  };
}

export type LiveSlotResult =
  | { ok: true; release: () => void }
  | { ok: false; reason: "user_limit" | "global_limit" };

/** Tracks concurrent Live sessions per user + globally. */
export class LiveSlots {
  private perUser = new Map<string, number>();
  private total = 0;

  private readonly limits: Pick<LiveLimits, "maxPerUser" | "maxGlobal">;

  constructor(limits: Pick<LiveLimits, "maxPerUser" | "maxGlobal">) {
    this.limits = limits;
  }

  acquire(userId: string): LiveSlotResult {
    if (this.total >= this.limits.maxGlobal) return { ok: false, reason: "global_limit" };
    const current = this.perUser.get(userId) ?? 0;
    if (current >= this.limits.maxPerUser) return { ok: false, reason: "user_limit" };
    this.perUser.set(userId, current + 1);
    this.total += 1;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.total = Math.max(0, this.total - 1);
        const left = (this.perUser.get(userId) ?? 1) - 1;
        if (left <= 0) this.perUser.delete(userId);
        else this.perUser.set(userId, left);
      },
    };
  }

  get activeTotal(): number {
    return this.total;
  }

  activeFor(userId: string): number {
    return this.perUser.get(userId) ?? 0;
  }
}

function offeredProtocols(req: IncomingMessage): string[] {
  const raw = req.headers["sec-websocket-protocol"];
  const value = Array.isArray(raw) ? raw.join(",") : raw;
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Preference order: `Sec-WebSocket-Protocol: bearer.<jwt>` → `Authorization: Bearer` →
 * (deprecated, env-gated) `?access_token=` / `?token=`.
 */
export function extractAccessToken(
  req: IncomingMessage,
  options: { allowQueryToken?: boolean } = {},
): string | null {
  const bearerProtocol = offeredProtocols(req).find((p) => p.startsWith(BEARER_PREFIX));
  if (bearerProtocol) {
    const token = bearerProtocol.slice(BEARER_PREFIX.length).trim();
    if (token) return token;
  }
  const header = req.headers.authorization;
  if (typeof header === "string" && header.toLowerCase().startsWith("bearer ")) {
    const token = header.slice(7).trim();
    if (token) return token;
  }
  if (options.allowQueryToken ?? true) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const fromQuery = url.searchParams.get("access_token") ?? url.searchParams.get("token");
    if (fromQuery && fromQuery.trim()) return fromQuery.trim();
  }
  return null;
}

/**
 * Select a subprotocol for the handshake. Prefer our own marker so the JWT is not echoed back.
 * Browsers fail the connection if they offered protocols and none is selected, so when only
 * `bearer.*` was offered we fall back to echoing it.
 */
export function selectLiveProtocol(protocols: Set<string>): string | false {
  if (protocols.has(LIVE_SUBPROTOCOL)) return LIVE_SUBPROTOCOL;
  for (const p of protocols) {
    if (!p.startsWith(BEARER_PREFIX)) return p;
  }
  const first = protocols.values().next();
  return first.done ? false : first.value;
}

let warnedQueryToken = false;

export function attachCompanionLiveUpgrade(
  server: import("node:http").Server,
  deps: LiveUpgradeDeps,
): void {
  const limits = loadLiveLimits(process.env, deps.limits);
  const slots = new LiveSlots(limits);
  const wss = new WebSocketServer({
    noServer: true,
    // Avoid deflate spikes on paced PCM binary frames (choppy Live audio).
    perMessageDeflate: false,
    handleProtocols: (protocols) => selectLiveProtocol(protocols),
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/v1/companion/live") {
      socket.destroy();
      return;
    }

    void (async () => {
      try {
        if (!deps.config.sessionSecret) {
          rejectUpgrade(socket, 503, "session_secret_missing");
          return;
        }
        const token = extractAccessToken(req, { allowQueryToken: limits.allowQueryToken });
        if (!token) {
          rejectUpgrade(socket, 401, "unauthorized");
          return;
        }
        const usedQuery = !offeredProtocols(req).some((p) => p.startsWith(BEARER_PREFIX)) &&
          !(typeof req.headers.authorization === "string" &&
            req.headers.authorization.toLowerCase().startsWith("bearer "));
        if (usedQuery && !warnedQueryToken) {
          warnedQueryToken = true;
          console.warn(
            "companion live: query-string access tokens are deprecated; use Sec-WebSocket-Protocol bearer.<jwt> (disable with LIVE_ALLOW_QUERY_TOKEN=0)",
          );
        }
        const claims = verifyAccessToken(
          deps.config.sessionSecret,
          token,
          nowSeconds(deps.now()),
        );
        if (!claims) {
          rejectUpgrade(socket, 401, "unauthorized");
          return;
        }
        const user = await deps.store.getUser(claims.sub);
        if (!user) {
          rejectUpgrade(socket, 401, "unauthorized");
          return;
        }
        if (!deps.config.geminiApiKey) {
          rejectUpgrade(socket, 503, "gemini_not_configured");
          return;
        }
        if (!deps.config.xaiApiKey) {
          rejectUpgrade(socket, 503, "xai_not_configured");
          return;
        }

        const slot = slots.acquire(user.id);
        if (!slot.ok) {
          rejectUpgrade(
            socket,
            slot.reason === "user_limit" ? 429 : 503,
            slot.reason === "user_limit" ? "too_many_live_sessions" : "live_capacity",
          );
          return;
        }
        const releaseSlot = slot.release;
        // Release when the TCP socket goes away (covers failed handshakes and normal closes);
        // release() is idempotent.
        socket.once("close", releaseSlot);

        wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
          ws.once("close", releaseSlot);
          wss.emit("connection", ws, req);
          void runCompanionLiveSession(ws, deps.config, {
            userId: user.id,
            store: deps.store,
            drive: deps.drive,
            calendar: deps.calendar,
          }).catch((error: unknown) => {
            console.warn(
              "companion live session ended",
              error instanceof Error ? error.message : error,
            );
            try {
              ws.close();
            } catch {
              /* ignore */
            }
          });
        });
      } catch (error) {
        console.warn("companion live upgrade failed", error);
        rejectUpgrade(socket, 500, "upgrade_failed");
      }
    })();
  });
}

const UPGRADE_MESSAGES: Record<string, string> = {
  unauthorized: "Sign in required for Live companion.",
  session_secret_missing: "Sign-in is temporarily unavailable.",
  gemini_not_configured: "Cloud voice is unavailable (Gemini Live not configured).",
  xai_not_configured: "Cloud voice is unavailable (Grok / XAI_API_KEY not configured).",
  too_many_live_sessions: "Too many Live sessions for this account. Close another tab and try again.",
  live_capacity: "Live companion is at capacity. Try again shortly.",
  upgrade_failed: "Could not start Live companion.",
};

function rejectUpgrade(socket: Duplex, status: number, code: string): void {
  const message = UPGRADE_MESSAGES[code] ?? "Live companion request failed.";
  const body = JSON.stringify({ error: { code, message } });
  const reason =
    status === 401
      ? "Unauthorized"
      : status === 429
        ? "Too Many Requests"
        : status === 503
          ? "Service Unavailable"
          : "Error";
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\n` +
      "Content-Type: application/json\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      "Connection: close\r\n\r\n" +
      body,
  );
  socket.destroy();
}
