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
import {
  buildCompanionChatSystem,
  buildCopilotChatSystem,
  buildSessionNoteSystem,
} from "../companion/geminiLive.ts";
import {
  createDriveClient,
  summarizeDriveFilesWithExcerpts,
  type DriveClient,
} from "../drive/client.ts";
import { geminiChat, type ChatTurn } from "../gemini/chat.ts";
import type { LiveChatInput } from "../gemini/liveChat.ts";
import {
  isLocalChatForced,
  ollamaChat,
  selectChatBackend,
  shouldFallbackToLocal,
} from "../gemini/localChat.ts";
import type { FetchLike } from "../gemini/ephemeral.ts";
import { googleConfigured, pendingTtlSeconds, type Config } from "../config.ts";
import { CHAT_BODY_MAX, HttpError, bearerToken, page, readJson, sendEmpty, sendHtml, sendJson } from "../http.ts";
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
  parseSessionNote,
  parseStudyMemory,
  parseTaskCreate,
  parseTaskPatch,
  sessionNoteExcerpt,
  stepProficiency,
  type Level,
} from "./model.ts";
import type { PublicUser, Store } from "../store/types.ts";
import { toolById, TOOL_CATALOG, type ToolCatalogEntry } from "../tools/catalog.ts";
import { handleCameraObserve, type CameraAnalyzeFn } from "../camera/routes.ts";
import type { CameraSessionStore } from "../camera/sessionStore.ts";

export type ProductDeps = {
  config: Config;
  store: Store;
  google: GoogleClient;
  calendar: CalendarClient;
  drive: DriveClient;
  calendarConnects: CalendarConnects;
  now: () => Date;
  fetch: FetchLike;
  /**
   * Override cloud text chat (tests).
   * Production uses REST generateContent with GEMINI_MODEL (Flash-Lite free tier).
   * Live (GEMINI_LIVE_MODEL) stays for voice companion only.
   */
  liveChat?: (input: LiveChatInput) => Promise<string>;
  /** In-memory presence state for camera accountability. */
  cameraSessions?: CameraSessionStore;
  /** Override Presage analyze (tests). */
  cameraAnalyze?: CameraAnalyzeFn;
};

function nowSeconds(now: Date): number {
  return Math.floor(now.getTime() / 1000);
}

/** Best-effort Google revoke. Never throws. */
async function revokeGoogleToken(deps: ProductDeps, token: string): Promise<void> {
  try {
    await deps.fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Local clear must still succeed if Google is unreachable.
  }
}

/**
 * Revoke every distinct tool refresh token that is not the identity token, then revoke identity once.
 * The same string is never sent to Google twice.
 */
async function revokeStoredGoogleGrant(deps: ProductDeps, userId: string): Promise<void> {
  try {
    const connections = await deps.store.listToolConnections(userId);
    const identity = (await deps.store.getCalendarConnection(userId)).refreshToken;
    const revoked = new Set<string>();
    const revokeOnce = async (token: string | null) => {
      if (!token || revoked.has(token)) return;
      revoked.add(token);
      await revokeGoogleToken(deps, token);
    };
    for (const row of connections) {
      if (row.refreshToken && row.refreshToken !== identity) await revokeOnce(row.refreshToken);
    }
    await revokeOnce(identity);
  } catch {
    // Local clear must still succeed if Google is unreachable.
  }
}

/** Disconnect tools and revoke a refresh token only when nothing else still stores it. */
async function disconnectTools(deps: ProductDeps, userId: string, toolIds: string[]): Promise<void> {
  const before = await deps.store.listToolConnections(userId);
  const identity = (await deps.store.getCalendarConnection(userId)).refreshToken;
  const candidates = new Set<string>();
  for (const toolId of toolIds) {
    const row = before.find((item) => item.toolId === toolId);
    if (row?.refreshToken) candidates.add(row.refreshToken);
    await deps.store.disconnectTool(userId, toolId);
  }
  const after = await deps.store.listToolConnections(userId);
  for (const token of candidates) {
    if (token === identity) continue;
    if (after.some((item) => item.refreshToken === token)) continue;
    await revokeGoogleToken(deps, token);
  }
}

async function clearLegacyCalendarFlag(deps: ProductDeps, userId: string): Promise<void> {
  const { refreshToken } = await deps.store.getCalendarConnection(userId);
  if (refreshToken) await deps.store.setCalendarGrant(userId, refreshToken, false);
  else await deps.store.setCalendarGrant(userId, null, false);
}

async function requireUser(deps: ProductDeps, req: IncomingMessage, now: Date): Promise<PublicUser> {
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
    path === "/v1/tools" ||
    /^\/v1\/tools\/[^/]+\/(?:connect|poll|disconnect)$/.test(path) ||
    path === "/v1/calendar/agenda" ||
    path === "/v1/calendar/summary" ||
    path === "/v1/calendar/events" ||
    path.startsWith("/v1/calendar/events/") ||
    path === "/v1/drive/recent" ||
    path === "/v1/drive/search" ||
    path === "/v1/gemini/chat" ||
    path === "/v1/companion/chat" ||
    path === "/v1/me/data" ||
    path === "/v1/tasks" ||
    path === "/v1/tasks/active" ||
    path.startsWith("/v1/tasks/") ||
    path === "/v1/sessions" ||
    path === "/v1/session-notes" ||
    path.startsWith("/v1/session-notes/") ||
    path === "/v1/camera/observe"
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

  if (method === "POST" && path === "/v1/camera/observe") {
    const user = await requireUser(deps, req, now);
    // Must be the shared process store from createApp — a per-request store
    // would reset presence ladder / welcome-back state every call.
    if (!deps.cameraSessions) {
      throw new HttpError(503, "camera_unavailable", "Camera accountability is unavailable.");
    }
    await handleCameraObserve(req, res, user, {
      config: deps.config,
      now: deps.now,
      store: deps.cameraSessions,
      analyzeClip: deps.cameraAnalyze,
    });
    return true;
  }

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
    await rejectBundledToolConnect(req, res, deps, now);
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
    await pollCalendar(url, res, deps, now);
    return true;
  }
  if (method === "GET" && path === "/v1/tools") {
    const user = await requireUser(deps, req, now);
    sendJson(res, 200, { tools: await publicTools(deps, user.id) });
    return true;
  }
  const toolAction = /^\/v1\/tools\/([^/]+)\/(connect|poll|disconnect)$/.exec(path);
  if (toolAction) {
    const toolId = decodeURIComponent(toolAction[1] ?? "");
    const action = toolAction[2];
    if (method === "POST" && action === "connect") {
      await startToolConnect(req, res, deps, now, toolId);
      return true;
    }
    if (method === "GET" && action === "poll") {
      requireCatalogTool(toolId);
      await pollCalendar(url, res, deps, now);
      return true;
    }
    if (method === "POST" && action === "disconnect") {
      const user = await requireUser(deps, req, now);
      requireCatalogTool(toolId);
      await disconnectTools(deps, user.id, [toolId]);
      sendEmpty(res, 204);
      return true;
    }
    throw new HttpError(405, "method_not_allowed", "Method not allowed.");
  }
  if (method === "GET" && path === "/v1/google/status") {
    const user = await requireUser(deps, req, now);
    const tools = await publicTools(deps, user.id);
    sendJson(res, 200, { ...connectionFlags(tools), tools });
    return true;
  }
  if (method === "POST" && path === "/v1/google/disconnect") {
    const user = await requireUser(deps, req, now);
    await disconnectTools(deps, user.id, TOOL_CATALOG.map((tool) => tool.id));
    await clearLegacyCalendarFlag(deps, user.id);
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
    await revokeStoredGoogleGrant(deps, user.id);
    await deps.store.clearUserData(user.id, now);
    sendEmpty(res, 204);
    return true;
  }
  if (method === "POST" && path === "/v1/gemini/chat") {
    const user = await requireUser(deps, req, now);
    const body = await readJson(req, CHAT_BODY_MAX);
    if (!body || typeof body !== "object") {
      throw new HttpError(400, "invalid_chat", "Expected a JSON object.");
    }
    const record = body as Record<string, unknown>;
    const message = typeof record.message === "string" ? record.message.trim() : "";
    if (!message) throw new HttpError(400, "invalid_chat", "message is required.");
    // Session notes must not use the Copilot role or the study-suggestion block.
    const system =
      record.purpose === "session_note"
        ? buildSessionNoteSystem(record.system)
        : buildCopilotChatSystem(record.system);
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
      // Client-supplied "system" turns would bypass the server-owned template.
      .filter((item) => item.role !== "system" && item.content.length > 0)
      .slice(-40);

    const reply = await chatWithLocalFallback(deps, {
      system,
      history,
      message,
    });
    // Same shape either way — desktop must not show quota / provider friction.
    sendJson(res, 200, { role: "assistant", content: reply, user_id: user.id });
    return true;
  }
  if (method === "POST" && path === "/v1/companion/chat") {
    const user = await requireUser(deps, req, now);
    const body = await readJson(req, CHAT_BODY_MAX);
    if (!body || typeof body !== "object") {
      throw new HttpError(400, "invalid_companion", "Expected a JSON object.");
    }
    const record = body as Record<string, unknown>;
    const message = typeof record.message === "string" ? record.message.trim() : "";
    if (!message) throw new HttpError(400, "invalid_companion", "message is required.");
    const history = parseChatHistory(record.history).slice(-40);
    // Server-owned template; any client-supplied `system` is ignored.
    const system = buildCompanionChatSystem(
      record.context && typeof record.context === "object"
        ? (record.context as Record<string, unknown>)
        : null,
    );

    const reply = await chatWithLocalFallback(deps, {
      system,
      history,
      message,
    });
    sendJson(res, 200, { role: "assistant", content: reply, user_id: user.id });
    return true;
  }
  if (method === "GET" && path === "/v1/drive/recent") {
    const user = await requireUser(deps, req, now);
    const access = await toolAccess(deps, user.id, "google_drive");
    const limit = clampInt(url.searchParams.get("limit"), 12, 1, 25);
    const files = await deps.drive.listRecent(access, limit);
    const summary = await summarizeDriveFilesWithExcerpts(
      deps.drive,
      access,
      files,
      "Recently modified Drive files (partial listing with text excerpts):",
      { maxFiles: limit, maxCharsPerFile: 4_000 },
    );
    sendJson(res, 200, { files, summary });
    return true;
  }
  if (method === "GET" && path === "/v1/drive/search") {
    const user = await requireUser(deps, req, now);
    const access = await toolAccess(deps, user.id, "google_drive");
    const q = url.searchParams.get("q") ?? "";
    const limit = clampInt(url.searchParams.get("limit"), 8, 1, 25);
    const files = await deps.drive.search(access, q, limit);
    const summary = await summarizeDriveFilesWithExcerpts(
      deps.drive,
      access,
      files,
      `Drive search for “${q.trim() || "…"}” (with text excerpts):`,
      { maxFiles: limit, maxCharsPerFile: 4_000 },
    );
    sendJson(res, 200, { files, summary });
    return true;
  }
  if (method === "GET" && path === "/v1/calendar/summary") {
    const user = await requireUser(deps, req, now);
    const days = windowDays(url.searchParams.get("days"));
    const access = await toolAccess(deps, user.id, "google_calendar");
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
    const access = await toolAccess(deps, user.id, "google_calendar");
    const timeMin = now.toISOString();
    const timeMax = new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
    const events = await deps.calendar.listEvents(access, timeMin, timeMax);
    sendJson(res, 200, classifyAgenda(events));
    return true;
  }
  if (method === "POST" && path === "/v1/calendar/events") {
    const user = await requireUser(deps, req, now);
    const access = await toolAccess(deps, user.id, "google_calendar");
    const body = await readJson(req);
    const draft = eventDraft(body);
    const created = await deps.calendar.insertEvent(access, draft.google);
    sendJson(res, 201, { ...present(created, draft.kind), html_link: created.htmlLink ?? null });
    return true;
  }

  const eventId = path.startsWith("/v1/calendar/events/") ? decodeURIComponent(path.slice("/v1/calendar/events/".length)) : null;
  if (eventId && !eventId.includes("/")) {
    const user = await requireUser(deps, req, now);
    const access = await toolAccess(deps, user.id, "google_calendar");
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

  if (method === "POST" && path === "/v1/session-notes") {
    const user = await requireUser(deps, req, now);
    const parsed = parseSessionNote(await readJson(req, SESSION_NOTE_BODY_MAX));
    const { note, created } = await deps.store.upsertSessionNote(user.id, {
      id: randomUUID(),
      user_id: user.id,
      created_at: now.toISOString(),
      ...parsed,
    });
    sendJson(res, created ? 201 : 200, note);
    return true;
  }
  if (method === "GET" && path === "/v1/session-notes") {
    const user = await requireUser(deps, req, now);
    sendJson(res, 200, { notes: await deps.store.listSessionNotes(user.id, 50) });
    return true;
  }
  const notePath = /^\/v1\/session-notes\/([^/]+)$/.exec(path);
  if (notePath && method === "GET") {
    const user = await requireUser(deps, req, now);
    const id = decodeURIComponent(notePath[1]!);
    if (!SESSION_NOTE_ID.test(id)) {
      throw new HttpError(404, "not_found", "Session note not found.");
    }
    const note = await deps.store.getSessionNote(user.id, id);
    if (!note) throw new HttpError(404, "not_found", "Session note not found.");
    sendJson(res, 200, note);
    return true;
  }

  throw new HttpError(405, "method_not_allowed", "Method not allowed.");
}

const SESSION_NOTE_BODY_MAX = 128 * 1024;
const SESSION_NOTE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function memoryCard(store: Store, userId: string) {
  const profile = await store.getProfile(userId);
  const proficiencies = await store.listProficiencies(userId);
  const samples = await store.listPaceSamples(userId, null);
  const recent_notes = (await store.listSessionNotes(userId, 5)).map((note) => ({
    id: note.id,
    session_id: note.session_id,
    ended_at: note.ended_at,
    kind: note.kind,
    goals: note.goals,
    excerpt: sessionNoteExcerpt(note.markdown),
  }));
  if (!profile) {
    return { ...emptyMemory(), proficiencies, pace: paceCards(samples), recent_notes };
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
    recent_notes,
  };
}

type CompanionTurn = { role: "user" | "assistant" | "system"; content: string };

function parseChatHistory(raw: unknown): CompanionTurn[] {
  if (!Array.isArray(raw)) return [];
  return raw
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
    // Client-supplied "system" turns would bypass the server-owned template.
    .filter((item) => item.role !== "system" && item.content.length > 0);
}

async function chatWithLocalFallback(
  deps: ProductDeps,
  input: {
    system: string;
    history: Array<{ role: "user" | "assistant" | "system"; content: string }>;
    message: string;
  },
): Promise<string> {
  const localReady = Boolean(deps.config.ollamaBaseUrl);
  const backend = selectChatBackend(deps.config);
  const forceLocal = isLocalChatForced(deps.config);

  // LOCAL_CHAT_PROVIDER=ollama|llama|local → Llama/Ollama only (no Gemini).
  if (backend === "ollama" || forceLocal) {
    if (!localReady) {
      throw new HttpError(
        503,
        "local_chat_not_configured",
        "Local Copilot is unavailable.",
      );
    }
    if (forceLocal) {
      console.warn(
        "LOCAL_CHAT_PROVIDER=ollama; using local Llama model",
        deps.config.ollamaChatModel,
      );
    } else {
      console.warn(
        "GEMINI_API_KEY unset; using local Ollama model",
        deps.config.ollamaChatModel,
      );
    }
    return ollamaChat({
      baseUrl: deps.config.ollamaBaseUrl!,
      model: deps.config.ollamaChatModel,
      system: input.system,
      history: input.history,
      message: input.message,
      numCtx: deps.config.ollamaChatNumCtx,
      fetchImpl: deps.fetch,
    });
  }

  // Cloud companion path: Gemini first, silent Ollama fallback on quota/outage.
  if (!deps.config.geminiApiKey) {
    throw new HttpError(
      503,
      "gemini_not_configured",
      "Copilot is unavailable.",
    );
  }

  try {
    // REST Flash-Lite (free tier). Live AUDIO is voice-only — not HTTP Copilot.
    if (deps.liveChat) {
      return await deps.liveChat({
        apiKey: deps.config.geminiApiKey,
        model: deps.config.geminiModel,
        system: input.system,
        history: input.history,
        message: input.message,
      });
    }
    return await geminiChat({
      apiKey: deps.config.geminiApiKey,
      model: deps.config.geminiModel,
      system: input.system,
      history: input.history as ChatTurn[],
      message: input.message,
      fetchImpl: deps.fetch,
    });
  } catch (error) {
    if (!localReady || !shouldFallbackToLocal(error)) throw error;
    console.warn(
      "Gemini chat unavailable; falling back to local Ollama model",
      deps.config.ollamaChatModel,
      error instanceof HttpError ? error.code : error,
    );
  }

  return ollamaChat({
    baseUrl: deps.config.ollamaBaseUrl!,
    model: deps.config.ollamaChatModel,
    system: input.system,
    history: input.history,
    message: input.message,
    numCtx: deps.config.ollamaChatNumCtx,
    fetchImpl: deps.fetch,
  });
}

function clampInt(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function requireCatalogTool(toolId: string): ToolCatalogEntry {
  const tool = toolById(toolId);
  if (!tool) throw new HttpError(404, "unknown_tool", "Unknown tool.");
  return tool;
}

function presentTool(tool: ToolCatalogEntry, connectedAt: string | null, connected: boolean): PublicTool {
  return {
    id: tool.id,
    provider: tool.provider,
    title: tool.title,
    summary: tool.summary,
    scopes: [...tool.scopes],
    scope_labels: [...tool.scopeLabels],
    status: connected ? "connected" : "disconnected",
    connected_at: connected ? connectedAt : null,
  };
}

async function publicTools(deps: ProductDeps, userId: string): Promise<PublicTool[]> {
  const rows = await deps.store.listToolConnections(userId);
  return TOOL_CATALOG.map((tool) => {
    const row = rows.find((item) => item.toolId === tool.id);
    const connected = row?.status === "connected" && Boolean(row.refreshToken);
    return presentTool(tool, row?.connectedAt ?? null, connected);
  });
}

function connectionFlags(tools: PublicTool[]) {
  const calendarConnected = tools.some((tool) => tool.id === "google_calendar" && tool.status === "connected");
  const driveConnected = tools.some((tool) => tool.id === "google_drive" && tool.status === "connected");
  return {
    calendar_connected: calendarConnected,
    drive_connected: driveConnected,
    google_connected: calendarConnected && driveConnected,
  };
}

async function rejectBundledToolConnect(req: IncomingMessage, _res: ServerResponse, deps: ProductDeps, now: Date) {
  await requireUser(deps, req, now);
  throw new HttpError(400, "tool_required", "Connect one tool at a time from Settings → Tools.");
}

async function startToolConnect(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ProductDeps,
  now: Date,
  toolId: string,
) {
  const user = await requireUser(deps, req, now);
  const tool = requireCatalogTool(toolId);
  if (!googleConfigured(deps.config)) {
    throw new HttpError(503, "google_not_configured", "Google sign-in is unavailable.");
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
    toolId: tool.id,
    expiresAt: now.getTime() + expiresIn * 1000,
    status: "pending",
  });
  sendJson(res, 200, {
    authorization_url: authorizationUrl({
      clientId: deps.config.googleClientId!,
      redirectUri: deps.config.calendarRedirectUri,
      state,
      codeVerifier,
      scopes: tool.scopes.join(" "),
      includeGrantedScopes: false,
    }),
    state,
    poll_token: pollToken,
    expires_in: expiresIn,
  });
}

async function calendarCallback(url: URL, res: ServerResponse, deps: ProductDeps, now: Date) {
  const claim = deps.calendarConnects.claim(url.searchParams.get("state") ?? "", now.getTime());
  if (!claim.ok) {
    sendHtml(res, 400, page("Tool not connected", "This link is invalid or expired. Return to Waypoint and try again."));
    return;
  }
  const tool = claim.pending.toolId ? toolById(claim.pending.toolId) : undefined;
  if (!tool) {
    deps.calendarConnects.fail(claim.pending, {
      code: "google_exchange_failed",
      message: "Connect one tool at a time from Settings → Tools.",
    });
    sendHtml(res, 400, page("Tool not connected", "Connect one tool at a time from Settings → Tools."));
    return;
  }
  const code = url.searchParams.get("code");
  if (url.searchParams.get("error") || !code) {
    deps.calendarConnects.fail(claim.pending, { code: "google_denied", message: `${tool.title} access was cancelled.` });
    sendHtml(res, 400, page(`${tool.title} not connected`, `Google did not grant ${tool.title} access. Return to Waypoint and try again.`));
    return;
  }
  try {
    if (!googleConfigured(deps.config)) {
      throw new HttpError(503, "google_not_configured", "Google sign-in is unavailable.");
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
    const nowIso = now.toISOString();
    await deps.store.upsertToolConnection(claim.pending.userId, {
      toolId: tool.id,
      provider: tool.provider,
      scopes: tool.scopes.join(" "),
      refreshToken: tokens.refreshToken,
      status: "connected",
      connectedAt: nowIso,
      updatedAt: nowIso,
    });
    deps.calendarConnects.complete(claim.pending);
    sendHtml(
      res,
      200,
      page(`${tool.title} connected`, `${tool.title} is linked. You can close this tab and return to Waypoint.`),
    );
  } catch (error) {
    deps.calendarConnects.fail(claim.pending, { code: "google_exchange_failed", message: `${tool.title} connection failed.` });
    if (!(error instanceof GoogleExchangeError) && !(error instanceof HttpError)) console.error(error);
    sendHtml(res, 502, page(`${tool.title} not connected`, `Waypoint could not finish ${tool.title} access. Return to the app and try again.`));
  }
}

async function pollCalendar(url: URL, res: ServerResponse, deps: ProductDeps, now: Date) {
  const pollToken = url.searchParams.get("poll_token");
  if (!pollToken) throw new HttpError(400, "poll_token_required", "Query parameter poll_token is required.");
  const result = deps.calendarConnects.poll(pollToken, now.getTime());
  if (result.type === "missing") throw new HttpError(404, "poll_not_found", "That tool connection was not found.");
  if (result.type === "expired") throw new HttpError(410, "poll_expired", "That tool connection expired. Start again.");
  if (result.type === "pending") {
    sendJson(res, 200, { status: "pending", expires_in: result.expiresIn });
    return;
  }
  if (result.type === "error") {
    sendJson(res, 200, { status: "error", error: result.error });
    return;
  }
  if (!result.toolId) {
    throw new HttpError(400, "tool_required", "Connect one tool at a time from Settings → Tools.");
  }
  const tools = await publicTools(deps, result.userId);
  sendJson(res, 200, {
    status: "complete",
    tool_id: result.toolId,
    status_connection: "connected",
    ...connectionFlags(tools),
  });
}

async function toolAccess(deps: ProductDeps, userId: string, toolId: string): Promise<string> {
  const rows = await deps.store.listToolConnections(userId);
  const row = rows.find((item) => item.toolId === toolId);
  if (!row || row.status !== "connected" || !row.refreshToken) {
    if (toolId === "google_drive") {
      throw new HttpError(409, "drive_not_connected", "Connect Google Drive before using it.");
    }
    throw new HttpError(409, "calendar_not_connected", "Connect Google Calendar before using it.");
  }
  if (!googleConfigured(deps.config)) {
    throw new HttpError(503, "google_not_configured", "Google sign-in is unavailable.");
  }
  return deps.calendar.refresh({
    refreshToken: row.refreshToken,
    clientId: deps.config.googleClientId!,
    clientSecret: deps.config.googleClientSecret!,
  });
}

type PublicTool = {
  id: string;
  provider: string;
  title: string;
  summary: string;
  scopes: string[];
  scope_labels: string[];
  status: "connected" | "disconnected";
  connected_at: string | null;
};

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
