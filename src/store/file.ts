import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import type {
  GoogleProfile,
  NewSessionEvent,
  NewStudySession,
  PublicUser,
  RotateResult,
  SessionEventRecord,
  Store,
  StoredRefreshToken,
  StudySessionRecord,
} from "./types.ts";

type UserRecord = PublicUser & {
  google_sub: string;
  google_refresh_token: string | null;
  created_at: string;
  last_login_at: string;
};

type FileData = {
  users: UserRecord[];
  refreshTokens: StoredRefreshToken[];
  studySessions: StudySessionRecord[];
  sessionEvents: SessionEventRecord[];
};

function empty(): FileData {
  return { users: [], refreshTokens: [], studySessions: [], sessionEvents: [] };
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
        studySessions: parsed.studySessions ?? [],
        sessionEvents: parsed.sessionEvents ?? [],
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
        const existing = data.users.find((user) => user.google_sub === profile.sub);
        if (existing) {
          existing.email = profile.email;
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
          email: profile.email,
          email_verified: profile.emailVerified,
          name: profile.name,
          picture: profile.picture,
          google_refresh_token: profile.googleRefreshToken,
          created_at: now.toISOString(),
          last_login_at: now.toISOString(),
        };
        data.users.push(created);
        await write(data);
        return toPublic(created);
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
    async createStudySession(input: NewStudySession) {
      return lock(async () => {
        const data = await read();
        const session: StudySessionRecord = {
          id: randomUUID(),
          user_id: input.userId,
          goals: input.goals,
          duration_secs: input.durationSecs,
          modality: input.modality,
          started_at: input.startedAt,
          ended_at: null,
        };
        data.studySessions.push(session);
        await write(data);
        return session;
      });
    },
    async getStudySession(sessionId, userId) {
      return lock(async () => {
        const data = await read();
        return (
          data.studySessions.find((session) => session.id === sessionId && session.user_id === userId) ??
          null
        );
      });
    },
    async listStudySessions(userId) {
      return lock(async () => {
        const data = await read();
        return data.studySessions.filter((session) => session.user_id === userId);
      });
    },
    async listSessionEvents(sessionId, userId) {
      return lock(async () => {
        const data = await read();
        return data.sessionEvents
          .filter((event) => event.session_id === sessionId && event.user_id === userId)
          .sort((a, b) => a.at.localeCompare(b.at));
      });
    },
    async appendSessionEvent(input: NewSessionEvent) {
      return lock(async () => {
        const data = await read();
        const session = data.studySessions.find(
          (item) => item.id === input.sessionId && item.user_id === input.userId,
        );
        if (!session) return null;
        const event: SessionEventRecord = {
          id: randomUUID(),
          session_id: input.sessionId,
          user_id: input.userId,
          type: input.type,
          at: input.at,
          payload: input.payload,
        };
        data.sessionEvents.push(event);
        if (input.type === "session_ended" && (!session.ended_at || input.at < session.ended_at)) {
          session.ended_at = input.at;
        }
        await write(data);
        return event;
      });
    },
    async close() {},
  };
}
