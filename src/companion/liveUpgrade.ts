import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";

import { verifyAccessToken } from "../auth/tokens.ts";
import type { Config } from "../config.ts";
import type { Store } from "../store/types.ts";
import { runCompanionLiveSession } from "./liveSession.ts";

export type LiveUpgradeDeps = {
  config: Config;
  store: Store;
  now: () => Date;
};

function nowSeconds(now: Date): number {
  return Math.floor(now.getTime() / 1000);
}

function extractAccessToken(req: IncomingMessage): string | null {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const fromQuery = url.searchParams.get("access_token") ?? url.searchParams.get("token");
  if (fromQuery && fromQuery.trim()) return fromQuery.trim();
  const header = req.headers.authorization;
  if (typeof header === "string" && header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim() || null;
  }
  const protocol = req.headers["sec-websocket-protocol"];
  if (typeof protocol === "string") {
    // Client may pass: Sec-WebSocket-Protocol: bearer.<jwt>
    const part = protocol.split(",").map((p) => p.trim()).find((p) => p.startsWith("bearer."));
    if (part) return part.slice("bearer.".length) || null;
  }
  return null;
}

export function attachCompanionLiveUpgrade(
  server: import("node:http").Server,
  deps: LiveUpgradeDeps,
): void {
  const wss = new WebSocketServer({ noServer: true });

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
        const token = extractAccessToken(req);
        if (!token) {
          rejectUpgrade(socket, 401, "unauthorized");
          return;
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

        wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
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
  socket.write(
    `HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : status === 503 ? "Service Unavailable" : "Error"}\r\n` +
      "Content-Type: application/json\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      "Connection: close\r\n\r\n" +
      body,
  );
  socket.destroy();
}
