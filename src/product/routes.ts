import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { authorizationUrl } from "../auth/google.ts";
import { GoogleExchangeError } from "../auth/google.ts";
import { newOpaqueToken } from "../auth/tokens.ts";
import { verifyAccessToken } from "../auth/tokens.ts";
import { CalendarConnects } from "../calendar/connect.ts";
import {
  classifyAgenda,
  dateOnly,
  isWaypoint,
  nextDate,
  studyBlockMinutes,
  type RawEvent,
} from "../calendar/classify.ts";
import { createCalendarClient, type CalendarClient } from "../calendar/client.ts";
import { createDriveClient, summarizeDriveFiles, type DriveClient } from "../drive/client.ts";
import { geminiChat } from "../gemini/chat.ts";
import type { FetchLike } from "../gemini/ephemeral.ts";
import { googleConfigured, pendingTtlSeconds, type Config } from "../config.ts";
import { HttpError, bearerToken, page, readJson, sendEmpty, sendHtml, sendJson } from "../http.ts";
import type { GoogleClient } from "../auth/google.ts";
import {
  actualMinutes,
  applyMemoryPut,
  emptyMemory,
  paceCards,
  parseComplete,
  parsePaceInput,
  parseProficiencyList,
  parseSession,
  parseStudyMemory,
  parseTaskCreate,
  parseTaskPatch,
  stepProficiency,
  type Level,
} from "./model.ts";
import type { PublicUser, Store } from "../store/types.ts";

/** Calendar write + Drive read for Copilot (second consent after Waypoint Google sign-in). */
const GOOGLE_DATA_SCOPES =
  "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/drive.readonly";

export type ProductDeps = {
  config: Config;
  store: Store;
  google: GoogleClient;
  calendar: CalendarClient;
  drive: DriveClient;
  calendarConnects: CalendarConnects;
  now: () => Date;
  fetch: FetchLike;
};

function nowSeconds(now: Date): number {
  return Math.floor(now.getTime() / 1000);
}

async function requireUser(deps: ProductDeps, req: IncomingMessage, now: Date): Promise<PublicUser> {
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

function isProductPath(path: string): boolean {
  return (
    path === "/v1/memory" ||
    path === "/v1/memory/pace" ||
    path === "/v1/memory/proficiency" ||
    path === "/v1/study-memory" ||
    path === "/v1/google/calendar/start" ||
    path === "/v1/google/calendar/callback" ||
    path === "/v1/google/calendar/poll" ||
    path === "/v1/google/connect/start" ||
    path === "/v1/google/connect/callback" ||
    path === "/v1/google/connect/poll" ||
    path === "/v1/google/status" ||
    path === "/v1/google/disconnect" ||
    path === "/v1/calendar/agenda" ||
    path === "/v1/calendar/summary" ||
    path === "/v1/calendar/events" ||
    path.startsWith("/v1/calendar/events/") ||
    path === "/v1/drive/recent" ||
    path === "/v1/drive/search" ||
    path === "/v1/gemini/chat" ||
    path === "/v1/me/data" ||
    path === "/v1/tasks" ||
    path === "/v1/tasks/active" ||
    path.startsWith("/v1/tasks/") ||
    path === "/v1/sessions"
  );
}

export async function handleProduct(
  method: string,
  path: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  deps: ProductDeps,
): Promise<boolean> {
  if (!isProductPath(path)) return false;
  const now = deps.now();

  if (method === "GET" && path === "/v1/memory") {
    const user = await requireUser(deps, req, now);
    sendJson(res, 200, await memoryCard(deps.store, user.id));
    return true;
  }
  if (method === "PUT" && path === "/v1/memory") {
    const user = await requireUser(deps, req, now);
    const body = await readJson(req);
    const current = await deps.store.getProfile(user.id);
    const next = applyMemoryPut(current, body, now);
    await deps.store.saveProfile(user.id, next);
    if (body && typeof body === "object" && "proficiencies" in body) {
      await deps.store.replaceProficiencies(user.id, parseProficiencyList(body.proficiencies), now);
    }
    sendJson(res, 200, await memoryCard(deps.store, user.id));
    return true;
  }
  if (method === "GET" && path === "/v1/memory/pace") {
    const user = await requireUser(deps, req, now);
    const topic = url.searchParams.get("topic");
    const limit = 8;
    const samples = (await deps.store.listPaceSamples(user.id, topic)).slice(0, limit);
    sendJson(res, 200, { samples });
    return true;
  }
  if (method === "POST" && path === "/v1/memory/pace") {
    const user = await requireUser(deps, req, now);
    const input = parsePaceInput(await readJson(req));
    const sample = await deps.store.addPaceSample(user.id, {
      id: randomUUID(),
      ...input,
      recorded_at: now.toISOString(),
    });
    sendJson(res, 201, sample);
    return true;
  }
  if (method === "POST" && path === "/v1/memory/proficiency") {
    const user = await requireUser(deps, req, now);
    const body = await readJson(req);
    const topic = body && typeof body === "object" && "topic" in body && typeof body.topic === "string" ? body.topic.trim() : "";
    if (!topic) throw new HttpError(400, "invalid_memory", "topic is required.");
    const existing = (await deps.store.listProficiencies(user.id)).find(
      (item) => item.topic.toLowerCase() === topic.toLowerCase(),
    );
    const level = stepProficiency(existing?.level ?? null, body && typeof body === "object" && "level" in body ? body.level : undefined);
    const storedTopic = existing && existing.topic.toLowerCase() === topic.toLowerCase() ? topic : topic;
    await deps.store.upsertProficiency(user.id, { topic: storedTopic, level }, now);
    sendJson(res, 200, { topic: storedTopic, level });
    return true;
  }

  if (
    (method === "POST" && path === "/v1/google/calendar/start") ||
    (method === "POST" && path === "/v1/google/connect/start")
  ) {
    await startCalendar(req, res, deps, now);
    return true;
  }
  if (
    (method === "GET" && path === "/v1/google/calendar/callback") ||
    (method === "GET" && path === "/v1/google/connect/callback")
  ) {
    await calendarCallback(url, res, deps, now);
    return true;
  }
  if (
    (method === "GET" && path === "/v1/google/calendar/poll") ||
    (method === "GET" && path === "/v1/google/connect/poll")
  ) {
    pollCalendar(url, res, deps, now);
    return true;
  }
  if (method === "GET" && path === "/v1/google/status") {
    const user = await requireUser(deps, req, now);
    const connection = await deps.store.getCalendarConnection(user.id);
    sendJson(res, 200, {
      google_connected: connection.connected,
      calendar_connected: connection.connected,
      drive_connected: connection.connected,
    });
    return true;
  }
  if (method === "POST" && path === "/v1/google/disconnect") {
    const user = await requireUser(deps, req, now);
    await deps.store.setCalendarGrant(user.id, null, false);
    sendEmpty(res, 204);
    return true;
  }
  if (method === "GET" && path === "/v1/study-memory") {
    const user = await requireUser(deps, req, now);
    const profile = await deps.store.getProfile(user.id);
    sendJson(res, 200, { study_memory: profile?.study_memory ?? null });
    return true;
  }
  if (method === "PUT" && path === "/v1/study-memory") {
    const user = await requireUser(deps, req, now);
    const body = await readJson(req);
    const blob = parseStudyMemory(body, now);
    const current = await deps.store.getProfile(user.id);
    const next = applyMemoryPut(current, { study_memory: blob }, now);
    await deps.store.saveProfile(user.id, next);
    sendJson(res, 200, { study_memory: blob });
    return true;
  }
  if (method === "DELETE" && path === "/v1/me/data") {
    const user = await requireUser(deps, req, now);
    await deps.store.clearUserData(user.id, now);
    sendEmpty(res, 204);
    return true;
  }
  if (method === "POST" && path === "/v1/gemini/chat") {
    const user = await requireUser(deps, req, now);
    if (!deps.config.geminiApiKey) {
      throw new HttpError(503, "gemini_not_configured", "Set GEMINI_API_KEY in .env.");
    }
    const body = await readJson(req);
    if (!body || typeof body !== "object") {
      throw new HttpError(400, "invalid_chat", "Expected a JSON object.");
    }
    const record = body as Record<string, unknown>;
    const message = typeof record.message === "string" ? record.message.trim() : "";
    if (!message) throw new HttpError(400, "invalid_chat", "message is required.");
    const system =
      typeof record.system === "string" && record.system.trim()
        ? record.system
        : "You are Waypoint, a school navigation coach.";
    const historyRaw = Array.isArray(record.history) ? record.history : [];
    const history = historyRaw
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map((item) => ({
        role:
          item.role === "assistant" || item.role === "model"
            ? ("assistant" as const)
            : item.role === "system"
              ? ("system" as const)
              : ("user" as const),
        content: typeof item.content === "string" ? item.content : "",
      }))
      .filter((item) => item.content.length > 0)
      .slice(-40);
    const reply = await geminiChat({
      apiKey: deps.config.geminiApiKey,
      model: deps.config.geminiModel,
      system,
      history,
      message,
      fetchImpl: deps.fetch,
    });
    sendJson(res, 200, { role: "assistant", content: reply, user_id: user.id });
    return true;
  }
  if (method === "GET" && path === "/v1/drive/recent") {
    const user = await requireUser(deps, req, now);
    const access = await googleAccess(deps, user.id);
    const limit = clampInt(url.searchParams.get("limit"), 6, 1, 20);
    const files = await deps.drive.listRecent(access, limit);
    sendJson(res, 200, {
      files,
      summary: summarizeDriveFiles(files, "Recently modified Drive files (partial listing):"),
    });
    return true;
  }
  if (method === "GET" && path === "/v1/drive/search") {
    const user = await requireUser(deps, req, now);
    const access = await googleAccess(deps, user.id);
    const q = url.searchParams.get("q") ?? "";
    const limit = clampInt(url.searchParams.get("limit"), 5, 1, 20);
    const files = await deps.drive.search(access, q, limit);
    sendJson(res, 200, {
      files,
      summary: summarizeDriveFiles(files, `Drive search for “${q.trim() || "…"}”:`),
    });
    return true;
  }
  if (method === "GET" && path === "/v1/calendar/summary") {
    const user = await requireUser(deps, req, now);
    const days = windowDays(url.searchParams.get("days"));
    const access = await googleAccess(deps, user.id);
    const timeMin = now.toISOString();
    const timeMax = new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
    const events = await deps.calendar.listEvents(access, timeMin, timeMax);
    const lines = events.slice(0, 12).map((event) => {
      const summary = event.summary ?? "(untitled)";
      const start =
        event.start?.dateTime ?? event.start?.date ?? "?";
      return `- ${start}: ${summary}`;
    });
    sendJson(res, 200, {
      summary:
        lines.length === 0
          ? `No upcoming calendar events in the next ${days} days.`
          : `Upcoming calendar:\n${lines.join("\n")}`,
      count: events.length,
    });
    return true;
  }
  if (method === "GET" && path === "/v1/calendar/agenda") {
    const user = await requireUser(deps, req, now);
    const days = windowDays(url.searchParams.get("days"));
    const access = await googleAccess(deps, user.id);
    const timeMin = now.toISOString();
    const timeMax = new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
    const events = await deps.calendar.listEvents(access, timeMin, timeMax);
    sendJson(res, 200, classifyAgenda(events));
    return true;
  }
  if (method === "POST" && path === "/v1/calendar/events") {
    const user = await requireUser(deps, req, now);
    const access = await googleAccess(deps, user.id);
    const body = await readJson(req);
    const draft = eventDraft(body);
    const created = await deps.calendar.insertEvent(access, draft.google);
    sendJson(res, 201, { ...present(created, draft.kind), html_link: created.htmlLink ?? null });
    return true;
  }

  const eventId = path.startsWith("/v1/calendar/events/") ? decodeURIComponent(path.slice("/v1/calendar/events/".length)) : null;
  if (eventId && !eventId.includes("/")) {
    const user = await requireUser(deps, req, now);
    const access = await googleAccess(deps, user.id);
    if (method === "PATCH") {
      const current = await deps.calendar.getEvent(access, eventId);
      if (!isWaypoint(current)) throw new HttpError(403, "not_waypoint_event", "Only Waypoint events can be changed.");
      const patched = await deps.calendar.patchEvent(access, eventId, patchDraft(await readJson(req), current));
      const kind = patched.extendedProperties?.private?.waypointKind === "deadline" ? "deadline" : "study_block";
      sendJson(res, 200, { ...present(patched, kind), html_link: patched.htmlLink ?? null });
      return true;
    }
    if (method === "DELETE") {
      const current = await deps.calendar.getEvent(access, eventId);
      if (!isWaypoint(current)) throw new HttpError(403, "not_waypoint_event", "Only Waypoint events can be changed.");
      await deps.calendar.deleteEvent(access, eventId);
      sendEmpty(res, 204);
      return true;
    }
  }

  if (method === "POST" && path === "/v1/tasks") {
    const user = await requireUser(deps, req, now);
    const input = parseTaskCreate(await readJson(req));
    const task = await deps.store.createTask(
      user.id,
      {
        id: randomUUID(),
        ...input,
        status: "active",
        outcome: null,
        started_at: now.toISOString(),
        ended_at: null,
      },
      now,
    );
    sendJson(res, 201, task);
    return true;
  }
  if (method === "GET" && path === "/v1/tasks/active") {
    const user = await requireUser(deps, req, now);
    const task = await deps.store.getActiveTask(user.id);
    if (!task) throw new HttpError(404, "no_active_task", "There is no active task.");
    sendJson(res, 200, task);
    return true;
  }
  const complete = /^\/v1\/tasks\/([^/]+)\/complete$/.exec(path);
  if (complete && method === "POST") {
    const user = await requireUser(deps, req, now);
    const task = await deps.store.getTask(user.id, decodeURIComponent(complete[1]!));
    if (!task || task.status !== "active") throw new HttpError(404, "no_active_task", "There is no active task.");
    const input = parseComplete(await readJson(req));
    const actual = actualMinutes(task.started_at, now, input.break_minutes);
    task.outcome = input.outcome;
    task.status = input.outcome === "abandoned" ? "dropped" : "done";
    task.ended_at = now.toISOString();
    await deps.store.saveTask(user.id, task);
    const sample = await deps.store.addPaceSample(user.id, {
      id: randomUUID(),
      topic: input.topic,
      problem: task.title,
      planned_minutes: task.planned_minutes,
      actual_minutes: actual,
      outcome: input.outcome,
      task_id: task.id,
      recorded_at: now.toISOString(),
    });
    sendJson(res, 200, { task, pace: sample });
    return true;
  }
  const taskPath = /^\/v1\/tasks\/([^/]+)$/.exec(path);
  if (taskPath && taskPath[1] !== "active" && method === "PATCH") {
    const user = await requireUser(deps, req, now);
    const task = await deps.store.getTask(user.id, decodeURIComponent(taskPath[1]!));
    if (!task) throw new HttpError(404, "no_active_task", "There is no active task.");
    const started = task.started_at;
    const next = parseTaskPatch(await readJson(req), task);
    next.started_at = started;
    await deps.store.saveTask(user.id, next);
    sendJson(res, 200, next);
    return true;
  }

  if (method === "POST" && path === "/v1/sessions") {
    const user = await requireUser(deps, req, now);
    const session = await deps.store.insertSession(user.id, { id: randomUUID(), ...parseSession(await readJson(req)) });
    sendJson(res, 201, session);
    return true;
  }
  if (method === "GET" && path === "/v1/sessions") {
    const user = await requireUser(deps, req, now);
    sendJson(res, 200, { sessions: await deps.store.listSessions(user.id) });
    return true;
  }

  throw new HttpError(405, "method_not_allowed", "Method not allowed.");
}

async function memoryCard(store: Store, userId: string) {
  const profile = await store.getProfile(userId);
  const proficiencies = await store.listProficiencies(userId);
  const samples = await store.listPaceSamples(userId, null);
  if (!profile) {
    return { ...emptyMemory(), proficiencies, pace: paceCards(samples) };
  }
  return {
    interests: profile.interests,
    proficiencies,
    long_term_goals: profile.long_term_goals,
    priorities: profile.priorities,
    pace: paceCards(samples),
    interaction: profile.interaction,
    updated_at: profile.updated_at,
    study_memory: profile.study_memory ?? null,
  };
}

function clampInt(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

async function startCalendar(req: IncomingMessage, res: ServerResponse, deps: ProductDeps, now: Date) {
  const user = await requireUser(deps, req, now);
  if (!googleConfigured(deps.config)) {
    throw new HttpError(503, "google_not_configured", "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.");
  }
  const state = newOpaqueToken();
  const pollToken = newOpaqueToken();
  const codeVerifier = newOpaqueToken();
  const expiresIn = pendingTtlSeconds();
  deps.calendarConnects.put({
    state,
    pollToken,
    codeVerifier,
    userId: user.id,
    expiresAt: now.getTime() + expiresIn * 1000,
    status: "pending",
  });
  sendJson(res, 200, {
    authorization_url: authorizationUrl({
      clientId: deps.config.googleClientId!,
      redirectUri: deps.config.calendarRedirectUri,
      state,
      codeVerifier,
      scopes: GOOGLE_DATA_SCOPES,
    }),
    state,
    poll_token: pollToken,
    expires_in: expiresIn,
  });
}

async function calendarCallback(url: URL, res: ServerResponse, deps: ProductDeps, now: Date) {
  const claim = deps.calendarConnects.claim(url.searchParams.get("state") ?? "", now.getTime());
  if (!claim.ok) {
    sendHtml(res, 400, page("Calendar not connected", "This link is invalid or expired. Return to Waypoint and try again."));
    return;
  }
  const code = url.searchParams.get("code");
  if (url.searchParams.get("error") || !code) {
    deps.calendarConnects.fail(claim.pending, { code: "google_denied", message: "Google Calendar access was cancelled." });
    sendHtml(res, 400, page("Calendar not connected", "Google did not grant Calendar access. Return to Waypoint and try again."));
    return;
  }
  try {
    if (!googleConfigured(deps.config)) {
      throw new HttpError(503, "google_not_configured", "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.");
    }
    const tokens = await deps.google.exchangeCode({
      code,
      codeVerifier: claim.pending.codeVerifier,
      clientId: deps.config.googleClientId!,
      clientSecret: deps.config.googleClientSecret!,
      redirectUri: deps.config.calendarRedirectUri,
    });
    if (!tokens.refreshToken) {
      throw new GoogleExchangeError("Google did not return a refresh token.");
    }
    await deps.store.setCalendarGrant(claim.pending.userId, tokens.refreshToken, true);
    deps.calendarConnects.complete(claim.pending);
    sendHtml(
      res,
      200,
      page("Google connected", "Calendar and Drive are linked. You can close this tab and return to Waypoint."),
    );
  } catch (error) {
    deps.calendarConnects.fail(claim.pending, { code: "google_exchange_failed", message: "Google connection failed." });
    if (!(error instanceof GoogleExchangeError) && !(error instanceof HttpError)) console.error(error);
    sendHtml(res, 502, page("Google not connected", "Waypoint could not finish Google access. Return to the app and try again."));
  }
}

function pollCalendar(url: URL, res: ServerResponse, deps: ProductDeps, now: Date) {
  const pollToken = url.searchParams.get("poll_token");
  if (!pollToken) throw new HttpError(400, "poll_token_required", "Query parameter poll_token is required.");
  const result = deps.calendarConnects.poll(pollToken, now.getTime());
  if (result.type === "missing") throw new HttpError(404, "poll_not_found", "That Calendar connection was not found.");
  if (result.type === "expired") throw new HttpError(410, "poll_expired", "That Calendar connection expired. Start again.");
  if (result.type === "pending") {
    sendJson(res, 200, { status: "pending", expires_in: result.expiresIn });
    return;
  }
  if (result.type === "error") {
    sendJson(res, 200, { status: "error", error: result.error });
    return;
  }
  sendJson(res, 200, {
    status: "complete",
    calendar_connected: true,
    google_connected: true,
    drive_connected: true,
  });
}

async function googleAccess(deps: ProductDeps, userId: string): Promise<string> {
  const connection = await deps.store.getCalendarConnection(userId);
  if (!connection.connected || !connection.refreshToken) {
    throw new HttpError(409, "calendar_not_connected", "Connect Google Calendar before using it.");
  }
  if (!googleConfigured(deps.config)) {
    throw new HttpError(503, "google_not_configured", "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.");
  }
  return deps.calendar.refresh({
    refreshToken: connection.refreshToken,
    clientId: deps.config.googleClientId!,
    clientSecret: deps.config.googleClientSecret!,
  });
}

function windowDays(value: string | null): number {
  if (value === null || value === "") return 14;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 30) {
    throw new HttpError(400, "invalid_window", "days must be an integer from 1 to 30.");
  }
  return parsed;
}

function eventDraft(body: unknown): { kind: "deadline" | "study_block"; google: Record<string, unknown> } {
  if (!body || typeof body !== "object") throw new HttpError(400, "invalid_event", "Expected a JSON object.");
  const record = body as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  if (!title || title.length > 120) throw new HttpError(400, "invalid_event", "title is required and must be at most 120 characters.");
  const kind = record.kind;
  const privateProps = { waypoint: "1", waypointKind: kind === "deadline" ? "deadline" : "study_block" };
  if (kind === "deadline") {
    const start = typeof record.start === "string" ? dateOnly(record.start) : null;
    if (!start) throw new HttpError(400, "invalid_event", "A deadline needs a start date.");
    return {
      kind: "deadline",
      google: {
        summary: title,
        start: { date: start },
        end: { date: nextDate(start) },
        extendedProperties: { private: privateProps },
      },
    };
  }
  if (kind !== "study_block") throw new HttpError(400, "invalid_event", "kind must be study_block or deadline.");
  const start = typeof record.start === "string" ? record.start : "";
  const end = typeof record.end === "string" ? record.end : "";
  const minutes = studyBlockMinutes(start, end);
  if (minutes === null || minutes < 10 || minutes > 240) {
    throw new HttpError(400, "invalid_event", "A study block must last between 10 and 240 minutes.");
  }
  return {
    kind: "study_block",
    google: {
      summary: title,
      start: { dateTime: start },
      end: { dateTime: end },
      extendedProperties: { private: privateProps },
    },
  };
}

function patchDraft(body: unknown, current: RawEvent): Record<string, unknown> {
  if (!body || typeof body !== "object") throw new HttpError(400, "invalid_event", "Expected a JSON object.");
  const record = body as Record<string, unknown>;
  const deadline = current.start?.date && !current.start.dateTime;
  if (deadline) {
    if (typeof record.due !== "string") throw new HttpError(400, "invalid_event", "A deadline patch needs due.");
    const due = dateOnly(record.due);
    if (!due) throw new HttpError(400, "invalid_event", "due must be a date.");
    return { start: { date: due }, end: { date: nextDate(due) } };
  }
  const start = typeof record.start === "string" ? record.start : "";
  const end = typeof record.end === "string" ? record.end : "";
  const minutes = studyBlockMinutes(start, end);
  if (minutes === null || minutes < 10 || minutes > 240) {
    throw new HttpError(400, "invalid_event", "A study block must last between 10 and 240 minutes.");
  }
  return { start: { dateTime: start }, end: { dateTime: end } };
}

function present(event: RawEvent, kind: "deadline" | "study_block") {
  const title = event.summary ?? "(untitled)";
  const waypoint = isWaypoint(event);
  if (kind === "deadline") {
    const due = event.start?.date ?? event.start?.dateTime?.slice(0, 10) ?? "";
    return { id: event.id ?? "", title, due, all_day: true, waypoint };
  }
  return {
    id: event.id ?? "",
    title,
    start: event.start?.dateTime ?? "",
    end: event.end?.dateTime ?? "",
    waypoint,
  };
}

export function defaultCalendar(fetchImpl: typeof fetch): CalendarClient {
  return createCalendarClient(fetchImpl);
}

export function defaultDrive(fetchImpl: typeof fetch): DriveClient {
  return createDriveClient(fetchImpl);
}

export type { Level };
