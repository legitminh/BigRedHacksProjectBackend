import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import { GoogleExchangeError, authorizationUrl, createGoogleClient, type GoogleClient } from "./auth/google.ts";
import { PendingLogins, type CompletedLogin } from "./auth/pending.ts";
import { hashToken, newOpaqueToken, signAccessToken, verifyAccessToken } from "./auth/tokens.ts";
import { googleConfigured, pendingTtlSeconds, type Config } from "./config.ts";
import { mintEphemeralToken, type FetchLike } from "./gemini/ephemeral.ts";
import {
  HttpError,
  applyCors,
  bearerToken,
  page,
  readJson,
  sendEmpty,
  sendError,
  sendHtml,
  sendJson,
} from "./http.ts";
import type { PublicUser, Store, StoredRefreshToken } from "./store/types.ts";

export type AppDeps = {
  config: Config;
  store: Store;
  pending?: PendingLogins;
  google?: GoogleClient;
  now?: () => Date;
  fetch?: FetchLike;
};

function nowSeconds(now: Date): number {
  return Math.floor(now.getTime() / 1000);
}

function issueAccessToken(config: Config, user: PublicUser, now: Date): string {
  if (!config.sessionSecret) {
    throw new HttpError(503, "session_secret_missing", "SESSION_SECRET must be at least 32 characters.");
  }
  return signAccessToken(
    config.sessionSecret,
    { sub: user.id, email: user.email },
    config.accessTokenTtlSeconds,
    nowSeconds(now),
  );
}

function newRefreshRecord(userId: string, now: Date, ttlSeconds: number): {
  token: string;
  record: StoredRefreshToken;
} {
  const token = newOpaqueToken();
  const createdAt = now.toISOString();
  return {
    token,
    record: {
      id: randomUUID(),
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
      revokedAt: null,
      replacedBy: null,
      createdAt,
    },
  };
}

async function requireUser(deps: AppDeps, req: IncomingMessage, now: Date): Promise<PublicUser> {
  if (!deps.config.sessionSecret) {
    throw new HttpError(503, "session_secret_missing", "SESSION_SECRET must be at least 32 characters.");
  }
  const token = bearerToken(req);
  if (!token) throw new HttpError(401, "unauthorized", "Sign in required.");
  const claims = verifyAccessToken(deps.config.sessionSecret, token, nowSeconds(now));
  if (!claims) throw new HttpError(401, "unauthorized", "Sign in required.");
  const user = await deps.store.getUser(claims.sub);
  if (!user) throw new HttpError(401, "unauthorized", "Sign in required.");
  return user;
}

export function createApp(deps: AppDeps): Server {
  const pending = deps.pending ?? new PendingLogins();
  const google = deps.google ?? createGoogleClient();
  const nowFn = deps.now ?? (() => new Date());
  const fetchImpl = deps.fetch ?? fetch;

  return createServer((req, res) => {
    applyCors(req, res, deps.config);
    if (req.method === "OPTIONS") {
      sendEmpty(res, 204);
      return;
    }
    void handle(req, res, { ...deps, pending, google, now: nowFn, fetch: fetchImpl }).catch(
      (error: unknown) => {
        if (!res.headersSent) sendError(res, error);
      },
    );
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: Required<Pick<AppDeps, "config" | "store" | "pending" | "google" | "now" | "fetch">>,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && path === "/health") {
    sendJson(res, 200, { ok: true, service: "waypoint-api", storage: deps.store.kind });
    return;
  }

  if (method === "POST" && path === "/v1/auth/google/start") {
    await startGoogle(res, deps);
    return;
  }
  if (method === "GET" && path === "/v1/auth/google/callback") {
    await googleCallback(url, res, deps);
    return;
  }
  if (method === "GET" && path === "/v1/auth/google/poll") {
    pollGoogle(url, res, deps);
    return;
  }
  if (method === "POST" && path === "/v1/auth/refresh") {
    await refresh(req, res, deps);
    return;
  }
  if (method === "POST" && path === "/v1/auth/sign-out") {
    await signOut(req, res, deps);
    return;
  }
  if (method === "GET" && path === "/v1/me") {
    const user = await requireUser(deps, req, deps.now());
    sendJson(res, 200, user);
    return;
  }
  if (method === "POST" && path === "/v1/session/ephemeral-token") {
    await issueEphemeralToken(req, res, deps);
    return;
  }

  if (
    path === "/v1/auth/google/start" ||
    path === "/v1/auth/refresh" ||
    path === "/v1/auth/sign-out" ||
    path === "/v1/me" ||
    path === "/v1/auth/google/callback" ||
    path === "/v1/auth/google/poll" ||
    path === "/v1/session/ephemeral-token" ||
    path === "/health"
  ) {
    throw new HttpError(405, "method_not_allowed", "Method not allowed.");
  }
  throw new HttpError(404, "not_found", "No route for that path.");
}

function assertLoginReady(config: Config): void {
  if (!googleConfigured(config)) {
    throw new HttpError(
      503,
      "google_not_configured",
      "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.",
    );
  }
  if (!config.sessionSecret) {
    throw new HttpError(503, "session_secret_missing", "SESSION_SECRET must be at least 32 characters.");
  }
}

async function startGoogle(
  res: ServerResponse,
  deps: Required<Pick<AppDeps, "config" | "pending" | "now">>,
): Promise<void> {
  assertLoginReady(deps.config);
  const now = deps.now();
  const state = newOpaqueToken();
  const pollToken = newOpaqueToken();
  const codeVerifier = newOpaqueToken();
  const expiresIn = pendingTtlSeconds();
  deps.pending.put({
    state,
    pollToken,
    codeVerifier,
    expiresAt: now.getTime() + expiresIn * 1000,
    status: "pending",
  });
  sendJson(res, 200, {
    authorization_url: authorizationUrl({
      clientId: deps.config.googleClientId!,
      redirectUri: deps.config.redirectUri,
      state,
      codeVerifier,
    }),
    state,
    poll_token: pollToken,
    expires_in: expiresIn,
  });
}

async function googleCallback(
  url: URL,
  res: ServerResponse,
  deps: Required<Pick<AppDeps, "config" | "store" | "pending" | "google" | "now">>,
): Promise<void> {
  const state = url.searchParams.get("state") ?? "";
  const now = deps.now();
  const claim = deps.pending.claim(state, now.getTime());
  if (!claim.ok) {
    sendHtml(
      res,
      400,
      page("Sign-in failed", "This sign-in link is invalid or has expired. Return to Waypoint and try again."),
    );
    return;
  }

  const googleError = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  if (googleError || !code) {
    deps.pending.fail(claim.pending, {
      code: "google_denied",
      message: "Google sign-in was cancelled.",
    });
    sendHtml(res, 400, page("Sign-in cancelled", "Google did not finish sign-in. Return to Waypoint and try again."));
    return;
  }

  try {
    assertLoginReady(deps.config);
    const tokens = await deps.google.exchangeCode({
      code,
      codeVerifier: claim.pending.codeVerifier,
      clientId: deps.config.googleClientId!,
      clientSecret: deps.config.googleClientSecret!,
      redirectUri: deps.config.redirectUri,
    });
    const profile = await deps.google.fetchUserInfo(tokens.accessToken);
    const user = await deps.store.upsertGoogleUser(
      {
        sub: profile.sub,
        email: profile.email,
        emailVerified: profile.emailVerified,
        name: profile.name,
        picture: profile.picture,
        googleRefreshToken: tokens.refreshToken,
      },
      now,
    );
    const refresh = newRefreshRecord(user.id, now, deps.config.refreshTokenTtlSeconds);
    await deps.store.insertRefreshToken(refresh.record);
    const result: CompletedLogin = {
      token_type: "Bearer",
      access_token: issueAccessToken(deps.config, user, now),
      refresh_token: refresh.token,
      expires_in: deps.config.accessTokenTtlSeconds,
      user,
    };
    deps.pending.complete(claim.pending, result);
    sendHtml(
      res,
      200,
      page("Waypoint connected", "You can close this tab and return to Waypoint."),
    );
  } catch (error) {
    const message =
      error instanceof GoogleExchangeError ? "Google sign-in failed." : "Sign-in could not be completed.";
    deps.pending.fail(claim.pending, { code: "google_exchange_failed", message });
    if (!(error instanceof GoogleExchangeError) && !(error instanceof HttpError)) console.error(error);
    sendHtml(res, 502, page("Sign-in failed", "Waypoint could not finish Google sign-in. Return to the app and try again."));
  }
}

function pollGoogle(
  url: URL,
  res: ServerResponse,
  deps: Required<Pick<AppDeps, "pending" | "now">>,
): void {
  const pollToken = url.searchParams.get("poll_token");
  if (!pollToken) {
    throw new HttpError(400, "poll_token_required", "Query parameter poll_token is required.");
  }
  const result = deps.pending.poll(pollToken, deps.now().getTime());
  if (result.type === "missing") {
    throw new HttpError(404, "poll_not_found", "That sign-in attempt was not found.");
  }
  if (result.type === "expired") {
    throw new HttpError(410, "poll_expired", "That sign-in attempt expired. Start again.");
  }
  if (result.type === "pending") {
    sendJson(res, 200, { status: "pending", expires_in: result.expiresIn });
    return;
  }
  if (result.type === "error") {
    sendJson(res, 200, { status: "error", error: result.error });
    return;
  }
  sendJson(res, 200, { status: "complete", ...result.result });
}

async function refresh(
  req: IncomingMessage,
  res: ServerResponse,
  deps: Required<Pick<AppDeps, "config" | "store" | "now">>,
): Promise<void> {
  if (!deps.config.sessionSecret) {
    throw new HttpError(503, "session_secret_missing", "SESSION_SECRET must be at least 32 characters.");
  }
  const body = await readJson(req);
  const refreshToken =
    body && typeof body === "object" && "refresh_token" in body ? body.refresh_token : undefined;
  if (typeof refreshToken !== "string" || refreshToken.length === 0) {
    throw new HttpError(400, "refresh_token_required", "refresh_token is required.");
  }
  const now = deps.now();
  const next = newRefreshRecord("pending", now, deps.config.refreshTokenTtlSeconds);
  const rotated = await deps.store.rotateRefreshToken(hashToken(refreshToken), next.record, now);
  if (rotated.status === "reuse") {
    throw new HttpError(401, "refresh_reuse", "That refresh token was already used. Sign in again.");
  }
  if (rotated.status !== "ok") {
    throw new HttpError(401, "invalid_refresh", "Refresh token is invalid.");
  }
  sendJson(res, 200, {
    token_type: "Bearer",
    access_token: issueAccessToken(deps.config, rotated.user, now),
    refresh_token: next.token,
    expires_in: deps.config.accessTokenTtlSeconds,
  });
}

async function issueEphemeralToken(
  req: IncomingMessage,
  res: ServerResponse,
  deps: Required<Pick<AppDeps, "config" | "store" | "now" | "fetch">>,
): Promise<void> {
  const now = deps.now();
  await requireUser(deps, req, now);
  await readJson(req);
  if (!deps.config.geminiApiKey) {
    throw new HttpError(503, "gemini_not_configured", "Set GEMINI_API_KEY in .env.");
  }
  const minted = await mintEphemeralToken({
    apiKey: deps.config.geminiApiKey,
    now,
    fetchImpl: deps.fetch,
  });
  sendJson(res, 200, {
    token: minted.token,
    expire_time: minted.expireTime,
    model: deps.config.geminiModel,
  });
}

async function signOut(
  req: IncomingMessage,
  res: ServerResponse,
  deps: Required<Pick<AppDeps, "config" | "store" | "now">>,
): Promise<void> {
  const now = deps.now();
  const user = await requireUser(deps, req, now);
  const body = await readJson(req);
  const all = Boolean(body && typeof body === "object" && "all" in body && body.all === true);
  const refreshToken =
    body && typeof body === "object" && "refresh_token" in body ? body.refresh_token : undefined;
  if (all) {
    await deps.store.revokeAllRefreshTokens(user.id, now);
    sendEmpty(res, 204);
    return;
  }
  if (typeof refreshToken !== "string" || refreshToken.length === 0) {
    throw new HttpError(400, "refresh_token_required", "Provide refresh_token or set all to true.");
  }
  const revoked = await deps.store.revokeRefreshToken(hashToken(refreshToken), user.id, now);
  if (!revoked) throw new HttpError(401, "invalid_refresh", "Refresh token is invalid.");
  sendEmpty(res, 204);
}
