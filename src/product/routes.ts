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
import {
  createCalendarClient,
  listEventsAcrossCalendars,
  type CalendarClient,
} from "../calendar/client.ts";
import {
  DEFAULT_WINDOW_DAYS,
  MAX_WINDOW_DAYS,
  calendarWindow,
  dateKeyIn,
  formatCalendarSummary,
  normalizeTimeZone,
} from "../calendar/window.ts";
import {
  buildCompanionChatSystem,
  buildCopilotChatSystem,
  buildSessionNoteSystem,
  selectGeminiChatModel,
} from "../companion/geminiLive.ts";
import {
  INVENTORY_DEFAULT_MAX_CHARS,
  INVENTORY_DEFAULT_MAX_FILES,
  INVENTORY_HARD_MAX_FILES,
  createDriveClient,
  formatDriveInventory,
  summarizeDriveFilesWithExcerpts,
  type DriveClient,
} from "../drive/client.ts";
import { readFileTextCached } from "../drive/cache.ts";
import { prepareLiteDepthContext } from "../drive/liteDepth.ts";
import {
  ensureSchoolDigest,
  getManualRefreshStatus,
  loadSchoolDigestForChat,
  schoolDigestContextFields,
  schoolDigestResponseFields,
} from "../drive/schoolDigest.ts";
import { runDeepBriefForQuery } from "../drive/weekBrief.ts";
import { geminiChat, type ChatTurn } from "../gemini/chat.ts";
import type { LiveChatInput } from "../gemini/liveChat.ts";
import {
  isLocalChatForced,
  ollamaChat,
  selectChatBackend,
  shouldFallbackToLocal,
} from "../gemini/localChat.ts";
import type { FetchLike } from "../http.ts";
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
import { handleCameraObserve, type CameraAnalyzeFn } from "../camera/routes.ts";
import type { CameraSessionStore } from "../camera/sessionStore.ts";

/**
 * Calendar write + Drive read for Copilot (second consent after Waypoint Google sign-in).
 * `calendar.readonly` is what lets us enumerate secondary calendars; without it we can
 * still read `primary`, so older grants keep working.
 */
const GOOGLE_DATA_SCOPES =
  "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/drive.readonly";

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
   * Production uses REST generateContent: GEMINI_MODEL (Flash-Lite) only; overview Flash is school-digest build only.
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

/** Best-effort: revoke the stored Google grant before we drop it. Never throws. */
async function revokeStoredGoogleGrant(deps: ProductDeps, userId: string): Promise<void> {
  try {
    const { refreshToken } = await deps.store.getCalendarConnection(userId);
    if (!refreshToken) return;
    await deps.fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Local clear must still succeed if Google is unreachable.
  }
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
    path === "/v1/calendar/agenda" ||
    path === "/v1/calendar/summary" ||
    path === "/v1/calendar/events" ||
    path.startsWith("/v1/calendar/events/") ||
    path === "/v1/drive/recent" ||
    path === "/v1/drive/search" ||
    path === "/v1/drive/inventory" ||
    path === "/v1/drive/folder" ||
    path === "/v1/drive/folders" ||
    path === "/v1/drive/deep-brief" ||
    path === "/v1/school-digest" ||
    path === "/v1/school-digest/refresh" ||
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
    await revokeStoredGoogleGrant(deps, user.id);
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
    await revokeStoredGoogleGrant(deps, user.id);
    await deps.store.clearUserData(user.id, now);
    sendEmpty(res, 204);
    return true;
  }
  if (method === "GET" && path === "/v1/school-digest") {
    const user = await requireUser(deps, req, now);
    if (!deps.config.geminiApiKey) {
      throw new HttpError(503, "gemini_not_configured", "School digest is unavailable.");
    }
    const tz = url.searchParams.get("tz");
    const access = await googleAccess(deps, user.id);
    const digest = await ensureSchoolDigest({
      drive: deps.drive,
      calendar: deps.calendar,
      store: deps.store,
      userId: user.id,
      accessToken: access,
      timeZone: tz ?? "UTC",
      now,
      geminiApiKey: deps.config.geminiApiKey,
      overviewModel: deps.config.geminiOverviewModel,
      fetchImpl: deps.fetch,
    });
    const refresh = await getManualRefreshStatus(deps.store, user.id, now);
    sendJson(res, 200, schoolDigestResponseFields(digest, refresh));
    return true;
  }
  if (method === "POST" && path === "/v1/school-digest/refresh") {
    const user = await requireUser(deps, req, now);
    if (!deps.config.geminiApiKey) {
      throw new HttpError(503, "gemini_not_configured", "School digest is unavailable.");
    }
    const tz = url.searchParams.get("tz");
    const access = await googleAccess(deps, user.id);
    const digest = await ensureSchoolDigest({
      drive: deps.drive,
      calendar: deps.calendar,
      store: deps.store,
      userId: user.id,
      accessToken: access,
      timeZone: tz ?? "UTC",
      now,
      geminiApiKey: deps.config.geminiApiKey,
      overviewModel: deps.config.geminiOverviewModel,
      fetchImpl: deps.fetch,
      force: true,
    });
    const refresh = await getManualRefreshStatus(deps.store, user.id, now);
    sendJson(res, 200, schoolDigestResponseFields(digest, refresh));
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
    const isSessionNote = record.purpose === "session_note";
    const tz = resolveChatTimeZone(record, url);
    const cachedDigest = isSessionNote
      ? null
      : await loadSchoolDigestForChat(deps.store, user.id, tz, now);
    const digestForSystem = cachedDigest
      ? { text: cachedDigest.digestText, date: cachedDigest.digestDate }
      : null;
    // Session notes stay off the Copilot role. Other chats get the school digest.
    const system = isSessionNote
      ? buildSessionNoteSystem(record.system)
      : buildCopilotChatSystem(record.system, digestForSystem);
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
    // Spoken UX stays calm; optional provider/degraded for Settings / diagnostics.
    sendJson(res, 200, {
      role: "assistant",
      content: reply.content,
      user_id: user.id,
      provider: reply.provider,
      degraded: reply.degraded,
    });
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
    const ctx =
      record.context && typeof record.context === "object"
        ? (record.context as Record<string, unknown>)
        : {};
    const tz = resolveChatTimeZone(ctx, url);
    const cachedDigest = await loadSchoolDigestForChat(deps.store, user.id, tz, now);
    const mergedContext = { ...ctx, ...schoolDigestContextFields(cachedDigest) };
    // Server-owned template; any client-supplied `system` is ignored.
    const system = buildCompanionChatSystem(mergedContext);

    const reply = await chatWithLocalFallback(deps, {
      system,
      history,
      message,
    });
    sendJson(res, 200, {
      role: "assistant",
      content: reply.content,
      user_id: user.id,
      provider: reply.provider,
      degraded: reply.degraded,
    });
    return true;
  }
  if (method === "GET" && path === "/v1/drive/recent") {
    const user = await requireUser(deps, req, now);
    const access = await googleAccess(deps, user.id);
    const limit = clampInt(url.searchParams.get("limit"), 20, 1, 40);
    const files = await deps.drive.listRecent(access, limit);
    const summary = await summarizeDriveFilesWithExcerpts(
      deps.drive,
      access,
      files,
      "Recently opened or edited Drive files (partial — most recent first, not the whole Drive):",
      { maxExcerptFiles: 4, maxCharsPerFile: 1_500 },
    );
    sendJson(res, 200, { files, summary });
    return true;
  }
  if (method === "GET" && path === "/v1/drive/search") {
    const user = await requireUser(deps, req, now);
    const access = await googleAccess(deps, user.id);
    const q = url.searchParams.get("q") ?? "";
    const limit = clampInt(url.searchParams.get("limit"), 12, 1, 40);
    const excerpts = clampInt(url.searchParams.get("excerpts"), 5, 0, 20);
    const full = ["1", "true", "yes", "on"].includes(
      (url.searchParams.get("full") ?? "").trim().toLowerCase(),
    );
    const maxChars = full
      ? clampInt(url.searchParams.get("max_chars"), 80_000, 4_000, 100_000)
      : clampInt(url.searchParams.get("max_chars"), 8_000, 500, 40_000);
    const files = await deps.drive.search(access, q, limit);
    if (files.length === 0) {
      const emptyHeading = full
        ? `LITE DEPTH for “${q.trim() || "…"}”:`
        : `Drive search hits for “${q.trim() || "…"}” (filename + full-text match; a search result, not the student's whole Drive):`;
      sendJson(res, 200, {
        files,
        summary: `${emptyHeading}\n(no files matched these keywords — try different wording, or browse the inventory)`,
      });
      return true;
    }
    // full=1: structure + Flash-Lite map-reduce — never raw FULL CONTENTS into chat.
    if (full) {
      const fileTexts: Array<{ name: string; mimeType: string; text: string }> = [];
      for (const file of files.slice(0, Math.max(excerpts, 1))) {
        const result = await readFileTextCached(
          deps.drive,
          deps.store,
          user.id,
          access,
          file,
          maxChars,
        );
        if (result.ok) {
          fileTexts.push({ name: file.name, mimeType: file.mimeType, text: result.text });
        }
      }
      const summary =
        fileTexts.length === 0
          ? `LITE DEPTH for “${q.trim() || "…"}”:\n(no readable text from matched files)`
          : await prepareLiteDepthContext({
              fileTexts,
              utterance: q.trim() || "read these files completely",
              geminiApiKey: deps.config.geminiApiKey,
              liteModel: deps.config.geminiModel,
              fetchImpl: deps.fetch,
            });
      sendJson(res, 200, { files, summary });
      return true;
    }
    const heading = `Drive search hits for “${q.trim() || "…"}” (filename + full-text match; a search result, not the student's whole Drive):`;
    const summary = await summarizeDriveFilesWithExcerpts(deps.drive, access, files, heading, {
      maxExcerptFiles: excerpts,
      maxCharsPerFile: maxChars,
      contentLabel: "Content excerpt",
    });
    sendJson(res, 200, { files, summary });
    return true;
  }
  if (method === "GET" && path === "/v1/drive/inventory") {
    const user = await requireUser(deps, req, now);
    const access = await googleAccess(deps, user.id);
    const limit = clampInt(
      url.searchParams.get("limit"),
      INVENTORY_DEFAULT_MAX_FILES,
      1,
      INVENTORY_HARD_MAX_FILES,
    );
    const maxChars = clampInt(
      url.searchParams.get("max_chars"),
      INVENTORY_DEFAULT_MAX_CHARS,
      500,
      80_000,
    );
    const page = await deps.drive.inventory(access, {
      maxFiles: limit,
      pageToken: url.searchParams.get("page_token"),
      includeFolderPaths: url.searchParams.get("paths") !== "0",
    });
    sendJson(res, 200, {
      files: page.files,
      count: page.files.length,
      folder_count: page.folderCount,
      truncated: page.truncated,
      next_page_token: page.nextPageToken,
      summary: formatDriveInventory(page.files, { maxChars, truncated: page.truncated }),
    });
    return true;
  }
  if (method === "GET" && path === "/v1/drive/folder") {
    const user = await requireUser(deps, req, now);
    const access = await googleAccess(deps, user.id);
    const folderId = (url.searchParams.get("id") ?? "").trim();
    if (!folderId) throw new HttpError(400, "invalid_folder", "Query parameter id is required.");
    const limit = clampInt(url.searchParams.get("limit"), 200, 1, 1_000);
    const files = await deps.drive.listFolder(access, folderId, limit);
    sendJson(res, 200, {
      files,
      count: files.length,
      summary: formatDriveInventory(files, {
        heading: "Contents of the requested Drive folder (names and types only):",
      }),
    });
    return true;
  }
  if (method === "GET" && path === "/v1/drive/folders") {
    const user = await requireUser(deps, req, now);
    const access = await googleAccess(deps, user.id);
    const q = url.searchParams.get("q") ?? "";
    const limit = clampInt(url.searchParams.get("limit"), 20, 1, 100);
    const folders = await deps.drive.findFolders(access, q, limit);
    sendJson(res, 200, { folders, count: folders.length });
    return true;
  }
  if (method === "GET" && path === "/v1/drive/deep-brief") {
    const user = await requireUser(deps, req, now);
    const window = calendarWindow(
      now,
      windowDays(url.searchParams.get("days")),
      url.searchParams.get("tz"),
    );
    const access = await googleAccess(deps, user.id);
    const events = await listEventsAcrossCalendars(
      deps.calendar,
      access,
      window.timeMin,
      window.timeMax,
      window.timeZone,
    );
    const calendarSummary = formatCalendarSummary(events, window, now);
    const invLimit = clampInt(
      url.searchParams.get("limit"),
      2_000,
      1,
      INVENTORY_HARD_MAX_FILES,
    );
    const page = await deps.drive.inventory(access, {
      maxFiles: invLimit,
      includeFolderPaths: url.searchParams.get("paths") !== "0",
    });
    const q = url.searchParams.get("q") ?? "";
    const brief = await runDeepBriefForQuery(
      {
        drive: deps.drive,
        cacheStore: deps.store,
        userId: user.id,
        accessToken: access,
        geminiApiKey: deps.config.geminiApiKey,
        liteModel: deps.config.geminiModel,
        fetchImpl: deps.fetch,
      },
      {
        utterance: q,
        calendarSummary,
        inventoryFiles: page.files,
        inventoryTruncated: page.truncated,
      },
    );
    let cachedCount = 0;
    for (const file of page.files.slice(0, 40)) {
      const row = await deps.store.getDriveFileCache(user.id, file.id);
      if (row && row.modifiedTime === (file.modifiedTime ?? "")) cachedCount += 1;
    }
    sendJson(res, 200, {
      summary: brief.summary,
      file_count: page.files.length,
      ...(cachedCount > 0 ? { cached_count: cachedCount } : {}),
      ...(brief.truncated ? { truncated: true } : {}),
    });
    return true;
  }
  if (method === "GET" && path === "/v1/calendar/summary") {
    const user = await requireUser(deps, req, now);
    const window = calendarWindow(
      now,
      windowDays(url.searchParams.get("days")),
      url.searchParams.get("tz"),
    );
    const access = await googleAccess(deps, user.id);
    const events = await listEventsAcrossCalendars(
      deps.calendar,
      access,
      window.timeMin,
      window.timeMax,
      window.timeZone,
    );
    sendJson(res, 200, {
      summary: formatCalendarSummary(events, window, now),
      count: events.length,
      time_zone: window.timeZone,
      time_min: window.timeMin,
      time_max: window.timeMax,
      today: window.todayKey,
      tomorrow: window.tomorrowKey,
    });
    return true;
  }
  if (method === "GET" && path === "/v1/calendar/agenda") {
    const user = await requireUser(deps, req, now);
    const window = calendarWindow(
      now,
      windowDays(url.searchParams.get("days")),
      url.searchParams.get("tz"),
    );
    const access = await googleAccess(deps, user.id);
    const events = await listEventsAcrossCalendars(
      deps.calendar,
      access,
      window.timeMin,
      window.timeMax,
      window.timeZone,
    );
    sendJson(res, 200, {
      ...classifyAgenda(events),
      time_zone: window.timeZone,
      today: window.todayKey,
      tomorrow: window.tomorrowKey,
    });
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

type ChatFallbackResult = {
  content: string;
  provider: "gemini" | "ollama";
  degraded: boolean;
};

async function chatWithLocalFallback(
  deps: ProductDeps,
  input: {
    system: string;
    history: Array<{ role: "user" | "assistant" | "system"; content: string }>;
    message: string;
  },
): Promise<ChatFallbackResult> {
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
    const content = await ollamaChat({
      baseUrl: deps.config.ollamaBaseUrl!,
      model: deps.config.ollamaChatModel,
      system: input.system,
      history: input.history,
      message: input.message,
      numCtx: deps.config.ollamaChatNumCtx,
      fetchImpl: deps.fetch,
    });
    return { content, provider: "ollama", degraded: false };
  }

  // Cloud companion path: Gemini first, Ollama fallback on quota/outage.
  if (!deps.config.geminiApiKey) {
    throw new HttpError(
      503,
      "gemini_not_configured",
      "Copilot is unavailable.",
    );
  }

  const chatModel = selectGeminiChatModel(deps.config, {
    system: input.system,
    message: input.message,
  });

  try {
    // REST Gemini always Flash-Lite for chat; overview Flash is digest-only (/v1/school-digest).
    let content: string;
    if (deps.liveChat) {
      content = await deps.liveChat({
        apiKey: deps.config.geminiApiKey,
        model: chatModel,
        system: input.system,
        history: input.history,
        message: input.message,
      });
    } else {
      content = await geminiChat({
        apiKey: deps.config.geminiApiKey,
        model: chatModel,
        system: input.system,
        history: input.history as ChatTurn[],
        message: input.message,
        fetchImpl: deps.fetch,
      });
    }
    return { content, provider: "gemini", degraded: false };
  } catch (error) {
    if (!localReady || !shouldFallbackToLocal(error)) throw error;
    console.warn(
      "Gemini chat unavailable; falling back to local Ollama model",
      deps.config.ollamaChatModel,
      error instanceof HttpError ? error.code : error,
    );
  }

  const content = await ollamaChat({
    baseUrl: deps.config.ollamaBaseUrl!,
    model: deps.config.ollamaChatModel,
    system: input.system,
    history: input.history,
    message: input.message,
    numCtx: deps.config.ollamaChatNumCtx,
    fetchImpl: deps.fetch,
  });
  return { content, provider: "ollama", degraded: true };
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

function resolveChatTimeZone(record: Record<string, unknown>, url: URL): string {
  const fromBody =
    (typeof record.time_zone === "string" && record.time_zone) ||
    (typeof record.tz === "string" && record.tz) ||
    (typeof record.timezone === "string" && record.timezone);
  const fromUrl = url.searchParams.get("tz");
  return normalizeTimeZone(fromBody ?? fromUrl);
}

async function googleAccess(deps: ProductDeps, userId: string): Promise<string> {
  const connection = await deps.store.getCalendarConnection(userId);
  if (!connection.connected || !connection.refreshToken) {
    throw new HttpError(409, "calendar_not_connected", "Connect Google Calendar before using it.");
  }
  if (!googleConfigured(deps.config)) {
    throw new HttpError(503, "google_not_configured", "Google sign-in is unavailable.");
  }
  return deps.calendar.refresh({
    refreshToken: connection.refreshToken,
    clientId: deps.config.googleClientId!,
    clientSecret: deps.config.googleClientSecret!,
  });
}

function windowDays(value: string | null): number {
  if (value === null || value === "") return DEFAULT_WINDOW_DAYS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_WINDOW_DAYS) {
    throw new HttpError(
      400,
      "invalid_window",
      `days must be an integer from 1 to ${MAX_WINDOW_DAYS}.`,
    );
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
