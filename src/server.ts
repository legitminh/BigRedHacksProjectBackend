import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import { EmailCodeGuard, newEmailCode, parseEmail, parseEmailCode } from "./auth/email.ts";
import { GoogleExchangeError, authorizationUrl, createGoogleClient, type GoogleClient } from "./auth/google.ts";
import { PendingLogins, type CompletedLogin } from "./auth/pending.ts";
import { hashToken, newOpaqueToken, signAccessToken, verifyAccessToken } from "./auth/tokens.ts";
import { emailCodeTtlSeconds, googleConfigured, pendingTtlSeconds, type Config } from "./config.ts";
import { CalendarConnects } from "./calendar/connect.ts";
import { createCalendarClient, type CalendarClient } from "./calendar/client.ts";
import { createDriveClient, type DriveClient } from "./drive/client.ts";
import { handleAdmin } from "./admin.ts";
import { coachTokenOk, handleCoach } from "./coach/ollama.ts";
import { attachCompanionLiveUpgrade } from "./companion/liveUpgrade.ts";
import { createMailer, type Mailer } from "./mailer.ts";
import {
  DEFAULT_RATE_RULES,
  RateLimiter,
  clientIp,
  rateLimited,
  type RateRules,
} from "./security/rateLimit.ts";
import { CameraSessionStore } from "./camera/sessionStore.ts";
import { handleProduct, type ProductDeps } from "./product/routes.ts";
import { handleVoiceHealth, handleVoiceTts } from "./voice/tts.ts";
import { aggregateStatus } from "./status/aggregate.ts";
import { TOOL_CATALOG } from "./tools/catalog.ts";
import {
  HttpError,
  type FetchLike,
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
  mailer?: Mailer;
  calendar?: CalendarClient;
  drive?: DriveClient;
  calendarConnects?: CalendarConnects;
  now?: () => Date;
  fetch?: FetchLike;
  /** Override Live text chat for tests (defaults to geminiLiveChat). */
  liveChat?: ProductDeps["liveChat"];
  /** Abuse-shield state; defaults to a fresh in-process limiter per app. */
  limiter?: RateLimiter;
  /** Override individual rate-limit rules (tests / ops). */
  rateRules?: Partial<RateRules>;
  /** Per-mailbox OTP brute-force guard; defaults to 5 failures → 15 min lockout. */
  emailCodeGuard?: EmailCodeGuard;
  /** Shared camera presence store (defaults to one per app process). */
  cameraSessions?: CameraSessionStore;
  /** Override Presage analyze for tests. */
  cameraAnalyze?: ProductDeps["cameraAnalyze"];
};

type Shields = {
  limiter: RateLimiter;
  rules: RateRules;
  emailCodeGuard: EmailCodeGuard;
};

type HandleDeps = Required<
  Pick<
    AppDeps,
    "config" | "store" | "pending" | "google" | "mailer" | "calendar" | "drive" | "calendarConnects" | "now" | "fetch"
  >
> & {
  shields: Shields;
  liveChat?: ProductDeps["liveChat"];
  cameraSessions: CameraSessionStore;
  cameraAnalyze?: ProductDeps["cameraAnalyze"];
};

function shieldIp(deps: HandleDeps, req: IncomingMessage): string {
  return clientIp(req, deps.config.trustProxy);
}

/** Throws 429 (+ Retry-After) when `id` exceeds `rule` for `bucket`. */
function limit(
  deps: Pick<HandleDeps, "shields" | "now">,
  bucket: string,
  id: string,
  rule: keyof RateRules,
): void {
  deps.shields.limiter.consume(bucket, id, deps.shields.rules[rule], deps.now().getTime());
}

function nowSeconds(now: Date): number {
  return Math.floor(now.getTime() / 1000);
}

function issueAccessToken(config: Config, user: PublicUser, now: Date): string {
  if (!config.sessionSecret) {
    throw new HttpError(503, "session_secret_missing", "Sign-in is temporarily unavailable.");
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
    throw new HttpError(503, "session_secret_missing", "Sign-in is temporarily unavailable.");
  }
  const token = bearerToken(req);
  if (!token) throw new HttpError(401, "unauthorized", "Sign in required.");
  const claims = verifyAccessToken(deps.config.sessionSecret, token, nowSeconds(now));
  if (!claims) throw new HttpError(401, "unauthorized", "Sign in required.");
  const user = await deps.store.getUser(claims.sub);
  if (!user) throw new HttpError(401, "unauthorized", "Sign in required.");
  return user;
}

/** Valid JWT → user; missing/invalid token → null (no 401). */
async function optionalUser(deps: AppDeps, req: IncomingMessage, now: Date): Promise<PublicUser | null> {
  if (!deps.config.sessionSecret) return null;
  const token = bearerToken(req);
  if (!token) return null;
  const claims = verifyAccessToken(deps.config.sessionSecret, token, nowSeconds(now));
  if (!claims) return null;
  return (await deps.store.getUser(claims.sub)) ?? null;
}

export function createApp(deps: AppDeps): Server {
  const pending = deps.pending ?? new PendingLogins();
  const google = deps.google ?? createGoogleClient();
  const mailer = deps.mailer ?? createMailer(deps.config);
  const nowFn = deps.now ?? (() => new Date());
  const fetchImpl = deps.fetch ?? fetch;
  const calendar = deps.calendar ?? createCalendarClient(fetchImpl);
  const drive = deps.drive ?? createDriveClient(fetchImpl);
  const calendarConnects = deps.calendarConnects ?? new CalendarConnects();
  const cameraSessions = deps.cameraSessions ?? new CameraSessionStore();
  const shields: Shields = {
    limiter: deps.limiter ?? new RateLimiter(),
    rules: { ...DEFAULT_RATE_RULES, ...deps.rateRules },
    emailCodeGuard: deps.emailCodeGuard ?? new EmailCodeGuard(),
  };

  const server = createServer((req, res) => {
    applyCors(req, res, deps.config);
    if (req.method === "OPTIONS") {
      sendEmpty(res, 204);
      return;
    }
    void handle(req, res, {
      ...deps,
      cameraSessions,
      pending,
      google,
      mailer,
      calendar,
      drive,
      calendarConnects,
      now: nowFn,
      fetch: fetchImpl,
      shields,
    }).catch(
      (error: unknown) => {
        if (!res.headersSent) sendError(res, error);
      },
    );
  });

  // Study companion Gemini Live proxy — desktop connects here only (never to Google).
  attachCompanionLiveUpgrade(server, {
    config: deps.config,
    store: deps.store,
    drive,
    calendar,
    now: nowFn,
  });

  return server;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandleDeps,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && path === "/health") {
    sendJson(res, 200, { ok: true, service: "waypoint-api", storage: deps.store.kind });
    return;
  }

  if (method === "GET" && path === "/v1/status") {
    limit(deps, "status", shieldIp(deps, req), "statusIp");
    const now = deps.now();
    const user = await optionalUser(deps, req, now);
    let googleTools: { connected: number; total: number } | null = null;
    if (user) {
      const rows = await deps.store.listToolConnections(user.id);
      const connectedIds = new Set(
        rows.filter((row) => row.status === "connected" && row.refreshToken).map((row) => row.toolId),
      );
      googleTools = {
        connected: TOOL_CATALOG.filter((tool) => connectedIds.has(tool.id)).length,
        total: TOOL_CATALOG.length,
      };
    }
    const body = await aggregateStatus({
      config: deps.config,
      store: deps.store,
      fetch: deps.fetch,
      user,
      googleTools,
      now: deps.now,
    });
    sendJson(res, 200, body);
    return;
  }

  if (await handleAdmin(method, path, req, res, { config: deps.config, store: deps.store })) {
    return;
  }

  if (method === "POST" && path === "/v1/auth/google/start") {
    limit(deps, "google-start", shieldIp(deps, req), "googleStartIp");
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
  if (method === "POST" && path === "/v1/auth/email/start") {
    await startEmail(req, res, deps);
    return;
  }
  if (method === "POST" && path === "/v1/auth/email/verify") {
    await verifyEmail(req, res, deps);
    return;
  }
  if (method === "POST" && path === "/v1/auth/refresh") {
    limit(deps, "refresh", shieldIp(deps, req), "refreshIp");
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
  if (
    await handleCoach(method, path, req, res, deps.config, deps.fetch, () =>
      // Baked desktop coach token OR signed-in Waypoint JWT.
      authorizeMetered(deps, req, "coach", "coachIp", "coachUser"),
    )
  ) {
    return;
  }
  if (handleVoiceHealth(method, path, res, deps.config)) {
    return;
  }
  if (
    await handleVoiceTts(method, path, req, res, deps.config, deps.fetch, () =>
      // Same auth as lock-in coach — study heads-ups may use JWT or coach token.
      authorizeMetered(deps, req, "tts", "ttsIp", "ttsUser"),
    )
  ) {
    return;
  }
  if (method === "POST" && (path === "/v1/gemini/chat" || path === "/v1/companion/chat")) {
    limit(deps, "chat", shieldIp(deps, req), "chatIp");
  }
  if (method === "POST" && path === "/v1/camera/observe") {
    // Meter by user id when JWT is present; fall back to IP before auth fails inside product.
    const user = await optionalUser(deps, req, deps.now());
    limit(deps, "camera-observe", user?.id ?? shieldIp(deps, req), "cameraObserveUser");
  }
  if (
    await handleProduct(method, path, url, req, res, {
      config: deps.config,
      store: deps.store,
      google: deps.google,
      calendar: deps.calendar,
      drive: deps.drive,
      calendarConnects: deps.calendarConnects,
      now: deps.now,
      fetch: deps.fetch,
      liveChat: deps.liveChat,
      cameraSessions: deps.cameraSessions,
      cameraAnalyze: deps.cameraAnalyze,
    })
  ) {
    return;
  }

  if (
    path === "/v1/auth/google/start" ||
    path === "/v1/auth/email/start" ||
    path === "/v1/auth/email/verify" ||
    path === "/v1/auth/refresh" ||
    path === "/v1/auth/sign-out" ||
    path === "/v1/me" ||
    path === "/v1/auth/google/callback" ||
    path === "/v1/auth/google/poll" ||
    path === "/v1/status" ||
    path === "/v1/voice/tts" ||
    path === "/v1/voice/health" ||
    path === "/health"
  ) {
    throw new HttpError(405, "method_not_allowed", "Method not allowed.");
  }
  throw new HttpError(404, "not_found", "No route for that path.");
}


/**
 * Coach/TTS gate: per-IP throttle first (so bad tokens can't be brute-forced), then
 * coach-token-or-JWT auth, then a per-identity throttle. The coach token is a shared
 * baked secret, so its identity is scoped by IP rather than one global bucket.
 */
async function authorizeMetered(
  deps: HandleDeps,
  req: IncomingMessage,
  bucket: string,
  ipRule: keyof RateRules,
  identityRule: keyof RateRules,
): Promise<void> {
  const ip = shieldIp(deps, req);
  limit(deps, `${bucket}-ip`, ip, ipRule);
  let identity: string;
  if (coachTokenOk(deps.config, req)) {
    identity = `token:${ip}`;
  } else {
    identity = `user:${(await requireUser(deps, req, deps.now())).id}`;
  }
  limit(deps, `${bucket}-id`, identity, identityRule);
}

async function startEmail(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandleDeps,
): Promise<void> {
  limit(deps, "email-start-ip", shieldIp(deps, req), "emailStartIp");
  const body = await readJson(req);
  const email = parseEmail(body && typeof body === "object" && "email" in body ? body.email : undefined);
  if (!email) {
    throw new HttpError(400, "invalid_email", "Enter a valid email address.");
  }
  limit(deps, "email-start-email", email, "emailStartEmail");
  if (!deps.config.sessionSecret) {
    throw new HttpError(503, "session_secret_missing", "Sign-in is temporarily unavailable.");
  }
  const now = deps.now();
  const code = newEmailCode();
  const expiresIn = emailCodeTtlSeconds();
  await deps.store.replaceEmailLoginCode({
    id: randomUUID(),
    email,
    codeHash: hashToken(code),
    expiresAt: new Date(now.getTime() + expiresIn * 1000).toISOString(),
    consumedAt: null,
    createdAt: now.toISOString(),
  });
  try {
    await deps.mailer.sendLoginCode({ to: email, code, expiresIn });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.error("email login delivery failed");
    throw new HttpError(502, "mail_failed", "Could not send the login email.");
  }
  sendJson(res, 200, { status: "sent", expires_in: expiresIn });
}

async function verifyEmail(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandleDeps,
): Promise<void> {
  if (!deps.config.sessionSecret) {
    throw new HttpError(503, "session_secret_missing", "Sign-in is temporarily unavailable.");
  }
  limit(deps, "email-verify-ip", shieldIp(deps, req), "emailVerifyIp");
  const body = await readJson(req);
  const record = body && typeof body === "object" ? body : {};
  const email = parseEmail("email" in record ? record.email : undefined);
  const code = parseEmailCode("code" in record ? record.code : undefined);
  if (!email) {
    throw new HttpError(401, "invalid_code", "That code is invalid or expired.");
  }
  const now = deps.now();
  const nowMs = now.getTime();
  const guard = deps.shields.emailCodeGuard;
  // Locked mailboxes are refused before touching the store, even for a correct code.
  const lockedFor = guard.lockedForSeconds(email, nowMs);
  if (lockedFor > 0) throw rateLimited(lockedFor, "otp_locked");
  const consumed = code ? await deps.store.consumeEmailLoginCode(email, hashToken(code), now) : false;
  if (!consumed) {
    if (guard.recordFailure(email, nowMs)) {
      throw rateLimited(guard.lockedForSeconds(email, nowMs), "otp_locked");
    }
    throw new HttpError(401, "invalid_code", "That code is invalid or expired.");
  }
  guard.recordSuccess(email);
  const user = await deps.store.findOrCreateUserByEmail(email, now);
  const refresh = newRefreshRecord(user.id, now, deps.config.refreshTokenTtlSeconds);
  await deps.store.insertRefreshToken(refresh.record);
  sendJson(res, 200, {
    token_type: "Bearer",
    access_token: issueAccessToken(deps.config, user, now),
    refresh_token: refresh.token,
    expires_in: deps.config.accessTokenTtlSeconds,
    user,
  });
}

function assertLoginReady(config: Config): void {
  if (!googleConfigured(config)) {
    throw new HttpError(
      503,
      "google_not_configured",
      "Google sign-in is unavailable.",
    );
  }
  if (!config.sessionSecret) {
    throw new HttpError(503, "session_secret_missing", "Sign-in is temporarily unavailable.");
  }
}

/** Sign-in + Calendar + Drive in one consent (required for the desktop app). */
const GOOGLE_LOGIN_SCOPES =
  "openid email profile https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/drive.readonly";

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
      scopes: GOOGLE_LOGIN_SCOPES,
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
    if (!tokens.refreshToken) {
      throw new GoogleExchangeError("Google did not return a refresh token for Waypoint sign-in.");
    }
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
      page(
        "Signed in to Waypoint",
        "Waypoint sign-in is complete. You can close this tab and return to Waypoint.",
      ),
    );
  } catch (error) {
    const detail =
      error instanceof Error && error.message.trim()
        ? error.message.trim()
        : "Sign-in could not be completed.";
    // Keep the real Google/API reason — the desktop poll surfaces this string.
    const message =
      error instanceof GoogleExchangeError
        ? detail
        : `Sign-in could not be completed. (${detail})`;
    deps.pending.fail(claim.pending, { code: "google_exchange_failed", message });
    console.error("Google sign-in callback failed:", error);
    sendHtml(
      res,
      502,
      page(
        "Sign-in failed",
        "Waypoint could not finish Google sign-in. Return to the app and try again.",
      ),
    );
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
    throw new HttpError(503, "session_secret_missing", "Sign-in is temporarily unavailable.");
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
