import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";

import { verifyAccessToken } from "../auth/tokens.ts";
import type { Config } from "../config.ts";
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
 * - LIVE_ALLOW_QUERY_TOKEN (default on for client compatibility; set 0 to disable the
 *   deprecated query-string token)
 */
export function loadLiveLimits(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<LiveLimits> = {},
): LiveLimits {
  return {
    maxPerUser: overrides.maxPerUser ?? positiveInt(env.LIVE_MAX_SESSIONS_PER_USER, 2),
    maxGlobal: overrides.maxGlobal ?? positiveInt(env.LIVE_MAX_SESSIONS_GLOBAL, 50),
    allowQueryToken: overrides.allowQueryToken ?? envFlag(env.LIVE_ALLOW_QUERY_TOKEN, true),
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
          void runCompanionLiveSession(ws, deps.config).catch((error: unknown) => {
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

function rejectUpgrade(socket: Duplex, status: number, code: string): void {
  const body = JSON.stringify({ error: { code, message: code } });
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
