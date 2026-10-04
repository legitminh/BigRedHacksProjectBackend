import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import { canonicalEmail } from "../auth/email.ts";
import { hashesMatch } from "../auth/tokens.ts";
import type {
  PaceSample,
  Proficiency,
  SessionNote,
  SessionRecap,
  StoredProfile,
  TaskRecord,
} from "../product/model.ts";
import { legacyGoogleToolConnections } from "../tools/catalog.ts";
import type {
  AdminBrowseResult,
  AdminBrowseTable,
  AdminOverview,
  AdminUserDetail,
  EmailLoginCode,
  GoogleProfile,
  PublicUser,
  RotateResult,
  Store,
  StoredRefreshToken,
  ToolConnection,
  ToolConnectionWrite,
} from "./types.ts";

type UserRecord = PublicUser & {
  google_sub: string | null;
  google_refresh_token: string | null;
  calendar_connected?: boolean;
  created_at: string;
  last_login_at: string;
};

type Owned<T> = T & { userId: string };

type FileData = {
  users: UserRecord[];
  refreshTokens: StoredRefreshToken[];
  emailCodes: EmailLoginCode[];
  profiles: Owned<StoredProfile>[];
  proficiencies: Owned<Proficiency & { updated_at: string }>[];
  paceSamples: Owned<PaceSample>[];
  tasks: Owned<TaskRecord>[];
  sessions: Owned<SessionRecap>[];
  sessionNotes: Owned<SessionNote>[];
  toolConnections: ToolConnection[];
};

function empty(): FileData {
  return {
    users: [],
    refreshTokens: [],
    emailCodes: [],
    profiles: [],
    proficiencies: [],
    paceSamples: [],
    tasks: [],
    sessions: [],
    sessionNotes: [],
    toolConnections: [],
  };
}

function toPublic(user: UserRecord): PublicUser {
  return {
    id: user.id,
    email: user.email,
    email_verified: user.email_verified,
    name: user.name,
    picture: user.picture,
  };
}

export function openFileStore(path: string): Store {
  let chain: Promise<void> = Promise.resolve();

  function lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function read(): Promise<FileData> {
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as FileData;
      return {
        users: parsed.users ?? [],
        refreshTokens: parsed.refreshTokens ?? [],
        emailCodes: parsed.emailCodes ?? [],
        profiles: parsed.profiles ?? [],
        proficiencies: parsed.proficiencies ?? [],
        paceSamples: parsed.paceSamples ?? [],
        tasks: parsed.tasks ?? [],
        sessions: parsed.sessions ?? [],
        sessionNotes: parsed.sessionNotes ?? [],
        toolConnections: parsed.toolConnections ?? [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty();
      throw error;
    }
  }

  async function write(data: FileData): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(data));
    await rename(tmp, path);
  }

  return {
    kind: "file",
    async upsertGoogleUser(profile: GoogleProfile, now: Date) {
      return lock(async () => {
        const data = await read();
        const email = canonicalEmail(profile.email);
        const bySub = data.users.find((user) => user.google_sub === profile.sub);
        const byEmail = bySub
          ? undefined
          : email
            ? data.users.find((user) => canonicalEmail(user.email) === email)
            : undefined;
        const existing = bySub ?? byEmail;
        if (existing) {
          if (
            existing.calendar_connected === true &&
            existing.google_refresh_token &&
            !data.toolConnections.some((row) => row.userId === existing.id)
          ) {
            data.toolConnections.push(
              ...legacyGoogleToolConnections(existing.id, existing.google_refresh_token, now.toISOString()),
            );
          }
          existing.google_sub = profile.sub;
          existing.email = email;
          existing.email_verified = profile.emailVerified;
          existing.name = profile.name;
          existing.picture = profile.picture;
          existing.last_login_at = now.toISOString();
          if (profile.googleRefreshToken) {
            existing.google_refresh_token = profile.googleRefreshToken;
          }
          await write(data);
          return toPublic(existing);
        }
        const created: UserRecord = {
          id: randomUUID(),
          google_sub: profile.sub,
          email,
          email_verified: profile.emailVerified,
          name: profile.name,
          picture: profile.picture,
          google_refresh_token: profile.googleRefreshToken,
          calendar_connected: false,
          created_at: now.toISOString(),
          last_login_at: now.toISOString(),
        };
        data.users.push(created);
        await write(data);
        return toPublic(created);
      });
    },
    async findOrCreateUserByEmail(email: string, now: Date) {
      return lock(async () => {
        const data = await read();
        const canonical = canonicalEmail(email);
        if (!canonical) throw new Error("Email is required.");
        const existing = data.users.find((user) => canonicalEmail(user.email) === canonical);
        if (existing) {
          existing.email = canonical;
          existing.email_verified = true;
          existing.last_login_at = now.toISOString();
          await write(data);
          return toPublic(existing);
        }
        const created: UserRecord = {
          id: randomUUID(),
          google_sub: null,
          email: canonical,
          email_verified: true,
          name: null,
          picture: null,
          google_refresh_token: null,
          calendar_connected: false,
          created_at: now.toISOString(),
          last_login_at: now.toISOString(),
        };
        data.users.push(created);
        await write(data);
        return toPublic(created);
      });
    },
    async replaceEmailLoginCode(code: EmailLoginCode) {
      await lock(async () => {
        const data = await read();
        const email = canonicalEmail(code.email);
        if (!email) throw new Error("Email is required.");
        data.emailCodes = data.emailCodes.filter((item) => canonicalEmail(item.email) !== email);
        data.emailCodes.push({ ...code, email });
        await write(data);
      });
    },
    async consumeEmailLoginCode(email: string, codeHash: string, now: Date) {
      return lock(async () => {
        const data = await read();
        const canonical = canonicalEmail(email);
        if (!canonical) return false;
        const active = [...data.emailCodes]
          .reverse()
          .find((item) => canonicalEmail(item.email) === canonical && !item.consumedAt);
        if (!active) return false;
        if (!hashesMatch(active.codeHash, codeHash)) return false;
        if (Date.parse(active.expiresAt) <= now.getTime()) return false;
        active.consumedAt = now.toISOString();
        await write(data);
        return true;
      });
    },
    async insertRefreshToken(token) {
      await lock(async () => {
        const data = await read();
        data.refreshTokens.push(token);
        await write(data);
      });
    },
    async rotateRefreshToken(oldHash, next, now) {
      return lock(async () => {
        const data = await read();
        const current = data.refreshTokens.find((token) => token.tokenHash === oldHash);
        if (!current) return { status: "invalid" } satisfies RotateResult;
        if (current.revokedAt) {
          if (current.replacedBy) {
            const revokedAt = now.toISOString();
            for (const token of data.refreshTokens) {
              if (token.userId === current.userId && !token.revokedAt) token.revokedAt = revokedAt;
            }
            await write(data);
            return { status: "reuse" } satisfies RotateResult;
          }
          return { status: "invalid" } satisfies RotateResult;
        }
        if (Date.parse(current.expiresAt) <= now.getTime()) {
          return { status: "invalid" } satisfies RotateResult;
        }
        const user = data.users.find((item) => item.id === current.userId);
        if (!user) return { status: "invalid" } satisfies RotateResult;
        current.revokedAt = now.toISOString();
        current.replacedBy = next.id;
        data.refreshTokens.push({ ...next, userId: current.userId });
        await write(data);
        return { status: "ok", user: toPublic(user) } satisfies RotateResult;
      });
    },
    async revokeRefreshToken(hash, userId, now) {
      return lock(async () => {
        const data = await read();
        const token = data.refreshTokens.find((item) => item.tokenHash === hash);
        if (!token || token.userId !== userId) return false;
        if (!token.revokedAt) token.revokedAt = now.toISOString();
        await write(data);
        return true;
      });
    },
    async revokeAllRefreshTokens(userId, now) {
      await lock(async () => {
        const data = await read();
        const revokedAt = now.toISOString();
        for (const token of data.refreshTokens) {
          if (token.userId === userId && !token.revokedAt) token.revokedAt = revokedAt;
        }
        await write(data);
      });
    },
    async adminOverview(): Promise<AdminOverview> {
      return lock(async () => {
        const data = await read();
        const nowMs = Date.now();
        const users = [...data.users]
          .sort((a, b) => Date.parse(b.last_login_at) - Date.parse(a.last_login_at))
          .slice(0, 100)
          .map((u) => ({
            id: u.id,
            email: u.email,
            name: u.name,
            created_at: u.created_at ?? null,
            last_login_at: u.last_login_at ?? null,
            calendar_connected: u.calendar_connected === true,
          }));
        return {
          storage: "file",
          userCount: data.users.length,
          sessionCount: data.sessions.length,
          taskCount: data.tasks.length,
          paceCount: data.paceSamples.length,
          proficiencyCount: data.proficiencies.length,
          profileCount: data.profiles.length,
          emailCodeCount: data.emailCodes.length,
          activeRefreshTokens: data.refreshTokens.filter(
            (t) => !t.revokedAt && Date.parse(t.expiresAt) > nowMs,
          ).length,
          users,
        };
      });
    },
    async adminUserDetail(userId): Promise<AdminUserDetail | null> {
      return lock(async () => {
        const data = await read();
        const user = data.users.find((item) => item.id === userId);
        if (!user) return null;
        const nowMs = Date.now();
        const tokens = data.refreshTokens.filter((t) => t.userId === userId);
        const profile = data.profiles.find((item) => item.userId === userId);
        return {
          user: {
            id: user.id,
            email: user.email,
            email_verified: user.email_verified,
            name: user.name,
            picture: user.picture,
            google_sub: user.google_sub,
            created_at: user.created_at ?? null,
            last_login_at: user.last_login_at ?? null,
            calendar_connected: user.calendar_connected === true,
            has_google_refresh_token: Boolean(user.google_refresh_token),
          },
          profile: profile
            ? {
                interests: profile.interests,
                long_term_goals: profile.long_term_goals,
                priorities: profile.priorities,
                interaction: profile.interaction,
                updated_at: profile.updated_at,
                study_memory: profile.study_memory ?? null,
              }
            : null,
          proficiencies: data.proficiencies
            .filter((item) => item.userId === userId)
            .map(({ topic, level }) => ({ topic, level })),
          pace: data.paceSamples
            .filter((item) => item.userId === userId)
            .map(({ userId: _u, ...rest }) => rest),
          tasks: data.tasks
            .filter((item) => item.userId === userId)
            .map(({ userId: _u, ...rest }) => rest),
          sessions: data.sessions
            .filter((item) => item.userId === userId)
            .map(({ userId: _u, ...rest }) => rest),
          tokens: {
            total: tokens.length,
            active: tokens.filter((t) => !t.revokedAt && Date.parse(t.expiresAt) > nowMs).length,
            revoked: tokens.filter((t) => Boolean(t.revokedAt)).length,
          },
        };
      });
    },
    async adminBrowse(table: AdminBrowseTable, limit = 200): Promise<AdminBrowseResult> {
      return lock(async () => {
        const data = await read();
        const cap = Math.min(500, Math.max(1, limit));
        const nowMs = Date.now();
        const pack = (rows: Record<string, unknown>[]): AdminBrowseResult => ({
          table,
          count: rows.length,
          truncated: rows.length > cap,
          rows: rows.slice(0, cap),
        });
        switch (table) {
          case "users":
            return pack(
              data.users.map((u) => ({
                id: u.id,
                email: u.email,
                name: u.name,
                email_verified: u.email_verified,
                google_sub: u.google_sub,
                calendar_connected: u.calendar_connected === true,
                has_google_refresh_token: Boolean(u.google_refresh_token),
                created_at: u.created_at,
                last_login_at: u.last_login_at,
              })),
            );
          case "tasks":
            return pack(data.tasks.map(({ userId, ...rest }) => ({ user_id: userId, ...rest })));
          case "sessions":
            return pack(data.sessions.map(({ userId, ...rest }) => ({ user_id: userId, ...rest })));
          case "session_notes":
            return pack(
              data.sessionNotes.map(({ userId, markdown, user_id: _userId, ...rest }) => ({
                user_id: userId,
                ...rest,
                markdown_chars: markdown.length,
              })),
            );
          case "pace":
            return pack(
              data.paceSamples.map(({ userId, ...rest }) => ({ user_id: userId, ...rest })),
            );
          case "proficiencies":
            return pack(
              data.proficiencies.map(({ userId, ...rest }) => ({ user_id: userId, ...rest })),
            );
          case "profiles":
            return pack(
              data.profiles.map((p) => ({
                user_id: p.userId,
                interests: p.interests,
                long_term_goals: p.long_term_goals,
                priorities: p.priorities,
                interaction: p.interaction,
                has_study_memory: Boolean(p.study_memory),
                study_memory: p.study_memory ?? null,
                updated_at: p.updated_at,
              })),
            );
          case "email_codes":
            return pack(
              data.emailCodes.map((c) => ({
                id: c.id,
                email: c.email,
                expires_at: c.expiresAt,
                consumed_at: c.consumedAt,
                created_at: c.createdAt,
                // never expose code_hash value in UI dump beyond presence
                has_code_hash: Boolean(c.codeHash),
              })),
            );
          case "refresh_tokens":
            return pack(
              data.refreshTokens.map((t) => ({
                id: t.id,
                user_id: t.userId,
                expires_at: t.expiresAt,
                revoked_at: t.revokedAt,
                created_at: t.createdAt,
                active: !t.revokedAt && Date.parse(t.expiresAt) > nowMs,
              })),
            );
          default:
            return { table, count: 0, truncated: false, rows: [] };
        }
      });
    },
    async getUser(id) {
      return lock(async () => {
        const data = await read();
        const user = data.users.find((item) => item.id === id);
        return user ? toPublic(user) : null;
      });
    },
    async getProfile(userId) {
      return lock(async () => {
        const data = await read();
        const profile = data.profiles.find((item) => item.userId === userId);
        if (!profile) return null;
        const { userId: _userId, ...rest } = profile;
        return rest;
      });
    },
    async saveProfile(userId, profile) {
      await lock(async () => {
        const data = await read();
        data.profiles = data.profiles.filter((item) => item.userId !== userId);
        data.profiles.push({ userId, ...profile });
        await write(data);
      });
    },
    async listProficiencies(userId) {
      return lock(async () => {
        const data = await read();
        return data.proficiencies
          .filter((item) => item.userId === userId)
          .map(({ topic, level }) => ({ topic, level }));
      });
    },
    async replaceProficiencies(userId, items, now) {
      await lock(async () => {
        const data = await read();
        data.proficiencies = data.proficiencies.filter((item) => item.userId !== userId);
        for (const item of items) {
          data.proficiencies.push({ userId, ...item, updated_at: now.toISOString() });
        }
        await write(data);
      });
    },
    async upsertProficiency(userId, item, now) {
      await lock(async () => {
        const data = await read();
        const key = item.topic.toLowerCase();
        data.proficiencies = data.proficiencies.filter(
          (row) => !(row.userId === userId && row.topic.toLowerCase() === key),
        );
        data.proficiencies.push({ userId, ...item, updated_at: now.toISOString() });
        await write(data);
      });
    },
    async addPaceSample(userId, sample) {
      await lock(async () => {
        const data = await read();
        data.paceSamples.push({ userId, ...sample });
        await write(data);
      });
      return sample;
    },
    async listPaceSamples(userId, topic) {
      return lock(async () => {
        const data = await read();
        return data.paceSamples
          .filter((sample) => sample.userId === userId)
          .filter((sample) => (topic ? sample.topic.toLowerCase() === topic.toLowerCase() : true))
          .map(({ userId: _userId, ...sample }) => sample)
          .sort((a, b) => Date.parse(b.recorded_at) - Date.parse(a.recorded_at));
      });
    },
    async getCalendarConnection(userId) {
      return lock(async () => {
        const data = await read();
        const user = data.users.find((item) => item.id === userId);
        if (!user) return { connected: false, refreshToken: null };
        return { connected: user.calendar_connected === true, refreshToken: user.google_refresh_token };
      });
    },
    async setCalendarGrant(userId, refreshToken, connected) {
      await lock(async () => {
        const data = await read();
        const user = data.users.find((item) => item.id === userId);
        if (!user) return;
        user.calendar_connected = connected;
        if (refreshToken) user.google_refresh_token = refreshToken;
        else if (!connected) user.google_refresh_token = null;
        await write(data);
      });
    },
    async listToolConnections(userId) {
      return lock(async () => {
        const data = await read();
        const mine = () => data.toolConnections.filter((row) => row.userId === userId).map((row) => ({ ...row }));
        if (mine().length > 0) return mine();
        const user = data.users.find((item) => item.id === userId);
        if (user?.calendar_connected === true && user.google_refresh_token) {
          const migrated = legacyGoogleToolConnections(userId, user.google_refresh_token, new Date().toISOString());
          data.toolConnections.push(...migrated);
          await write(data);
          return migrated.map((row) => ({ ...row }));
        }
        return [];
      });
    },
    async upsertToolConnection(userId, connection: ToolConnectionWrite) {
      await lock(async () => {
        const data = await read();
        const next: ToolConnection = { userId, ...connection };
        const index = data.toolConnections.findIndex((row) => row.userId === userId && row.toolId === connection.toolId);
        if (index >= 0) data.toolConnections[index] = next;
        else data.toolConnections.push(next);
        await write(data);
      });
    },
    async disconnectTool(userId, toolId) {
      await lock(async () => {
        const data = await read();
        const row = data.toolConnections.find((item) => item.userId === userId && item.toolId === toolId);
        if (!row) return;
        row.refreshToken = null;
        row.status = "disconnected";
        row.updatedAt = new Date().toISOString();
        await write(data);
      });
    },
    async createTask(userId, task, now) {
      await lock(async () => {
        const data = await read();
        for (const existing of data.tasks) {
          if (existing.userId === userId && existing.status === "active") {
            existing.status = "dropped";
            existing.ended_at = now.toISOString();
          }
        }
        data.tasks.push({ userId, ...task });
        await write(data);
      });
      return task;
    },
    async getActiveTask(userId) {
      return lock(async () => {
        const data = await read();
        const task = data.tasks.find((item) => item.userId === userId && item.status === "active");
        if (!task) return null;
        const { userId: _userId, ...rest } = task;
        return rest;
      });
    },
    async getTask(userId, id) {
      return lock(async () => {
        const data = await read();
        const task = data.tasks.find((item) => item.userId === userId && item.id === id);
        if (!task) return null;
        const { userId: _userId, ...rest } = task;
        return rest;
      });
    },
    async saveTask(userId, task) {
      await lock(async () => {
        const data = await read();
        const index = data.tasks.findIndex((item) => item.userId === userId && item.id === task.id);
        if (index < 0) return;
        data.tasks[index] = { userId, ...task };
        await write(data);
      });
    },
    async insertSession(userId, session) {
      await lock(async () => {
        const data = await read();
        data.sessions.push({ userId, ...session });
        await write(data);
      });
      return session;
    },
    async listSessions(userId) {
      return lock(async () => {
        const data = await read();
        return data.sessions
          .filter((session) => session.userId === userId)
          .map(({ userId: _userId, ...session }) => session)
          .sort((a, b) => Date.parse(b.ended_at) - Date.parse(a.ended_at));
      });
    },
    async upsertSessionNote(userId, note) {
      return lock(async () => {
        const data = await read();
        const index = data.sessionNotes.findIndex(
          (item) => item.userId === userId && item.session_id === note.session_id,
        );
        if (index >= 0) {
          const existing = data.sessionNotes[index]!;
          const updated: Owned<SessionNote> = {
            ...existing,
            userId,
            user_id: userId,
            started_at: note.started_at,
            ended_at: note.ended_at,
            goals: note.goals,
            kind: note.kind,
            markdown: note.markdown,
          };
          data.sessionNotes[index] = updated;
          await write(data);
          const { userId: _userId, ...stored } = updated;
          return { note: stored, created: false };
        }
        const created: Owned<SessionNote> = { ...note, userId, user_id: userId };
        data.sessionNotes.push(created);
        await write(data);
        const { userId: _userId, ...stored } = created;
        return { note: stored, created: true };
      });
    },
    async listSessionNotes(userId, limit) {
      return lock(async () => {
        const data = await read();
        const cap = Math.min(50, Math.max(0, limit));
        return data.sessionNotes
          .filter((note) => note.userId === userId)
          .map(({ userId: _userId, ...note }) => note)
          .sort(
            (a, b) =>
              Date.parse(b.ended_at) - Date.parse(a.ended_at) ||
              Date.parse(b.created_at) - Date.parse(a.created_at),
          )
          .slice(0, cap);
      });
    },
    async getSessionNote(userId, id) {
      return lock(async () => {
        const data = await read();
        const note = data.sessionNotes.find((item) => item.userId === userId && item.id === id);
        if (!note) return null;
        const { userId: _userId, ...stored } = note;
        return stored;
      });
    },
    async clearUserData(userId, _now) {
      await lock(async () => {
        const data = await read();
        const user = data.users.find((item) => item.id === userId);
        const email = user?.email ? user.email.trim().toLowerCase() : null;
        data.profiles = data.profiles.filter((item) => item.userId !== userId);
        data.proficiencies = data.proficiencies.filter((item) => item.userId !== userId);
        data.paceSamples = data.paceSamples.filter((item) => item.userId !== userId);
        data.tasks = data.tasks.filter((item) => item.userId !== userId);
        data.sessions = data.sessions.filter((item) => item.userId !== userId);
        data.sessionNotes = data.sessionNotes.filter((item) => item.userId !== userId);
        data.refreshTokens = data.refreshTokens.filter((item) => item.userId !== userId);
        data.toolConnections = data.toolConnections.filter((item) => item.userId !== userId);
        if (email) {
          data.emailCodes = data.emailCodes.filter(
            (item) => item.email.trim().toLowerCase() !== email,
          );
        }
        data.users = data.users.filter((item) => item.id !== userId);
        await write(data);
      });
    },
    async close() {},
  };
}
