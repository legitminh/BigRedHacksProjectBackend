import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import { canonicalEmail } from "../auth/email.ts";
import { hashesMatch } from "../auth/tokens.ts";
import type {
  PaceSample,
  Proficiency,
  SessionRecap,
  StoredProfile,
  TaskRecord,
} from "../product/model.ts";
import type {
  EmailLoginCode,
  GoogleProfile,
  PublicUser,
  RotateResult,
  Store,
  StoredRefreshToken,
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
    async close() {},
  };
}
