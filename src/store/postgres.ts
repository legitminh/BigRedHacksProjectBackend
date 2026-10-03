import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";

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

type UserRow = {
  id: string;
  email: string | null;
  email_verified: boolean;
  name: string | null;
  picture: string | null;
};

type SessionRow = {
  id: string;
  user_id: string;
  goals: string;
  duration_secs: number | string;
  modality: string;
  started_at: Date | string;
  ended_at: Date | string | null;
};

type EventRow = {
  id: string;
  session_id: string;
  user_id: string;
  type: string;
  at: Date | string;
  payload: unknown;
};

function toPublic(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    email_verified: row.email_verified,
    name: row.name,
    picture: row.picture,
  };
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function asPayload(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function toSession(row: SessionRow): StudySessionRecord {
  return {
    id: row.id,
    user_id: row.user_id,
    goals: row.goals,
    duration_secs: Number(row.duration_secs),
    modality: row.modality,
    started_at: iso(row.started_at),
    ended_at: row.ended_at ? iso(row.ended_at) : null,
  };
}

function toEvent(row: EventRow): SessionEventRecord {
  return {
    id: row.id,
    session_id: row.session_id,
    user_id: row.user_id,
    type: row.type,
    at: iso(row.at),
    payload: asPayload(row.payload),
  };
}

export async function openPostgres(databaseUrl: string): Promise<Store> {
  const pool = new Pool({ connectionString: databaseUrl });
  const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "../db/schema.sql");
  const schema = readFileSync(schemaPath, "utf8");
  for (const statement of schema
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)) {
    await pool.query(statement);
  }

  return {
    kind: "postgres",
    async upsertGoogleUser(profile: GoogleProfile, now: Date) {
      const result = await pool.query<UserRow>(
        `INSERT INTO users (
           id, google_sub, email, email_verified, name, picture, google_refresh_token, created_at, last_login_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
         ON CONFLICT (google_sub) DO UPDATE SET
           email = EXCLUDED.email,
           email_verified = EXCLUDED.email_verified,
           name = EXCLUDED.name,
           picture = EXCLUDED.picture,
           google_refresh_token = COALESCE(EXCLUDED.google_refresh_token, users.google_refresh_token),
           last_login_at = EXCLUDED.last_login_at
         RETURNING id, email, email_verified, name, picture`,
        [
          randomUUID(),
          profile.sub,
          profile.email,
          profile.emailVerified,
          profile.name,
          profile.picture,
          profile.googleRefreshToken,
          now.toISOString(),
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error("User upsert returned no row.");
      return toPublic(row);
    },
    async insertRefreshToken(token: StoredRefreshToken) {
      await pool.query(
        `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, revoked_at, replaced_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          token.id,
          token.userId,
          token.tokenHash,
          token.expiresAt,
          token.revokedAt,
          token.replacedBy,
          token.createdAt,
        ],
      );
    },
    async rotateRefreshToken(oldHash, next, now): Promise<RotateResult> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const found = await client.query<{
          id: string;
          user_id: string;
          expires_at: Date;
          revoked_at: Date | null;
          replaced_by: string | null;
        }>(
          `SELECT id, user_id, expires_at, revoked_at, replaced_by
           FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
          [oldHash],
        );
        const current = found.rows[0];
        if (!current) {
          await client.query("ROLLBACK");
          return { status: "invalid" };
        }
        if (current.revoked_at) {
          if (current.replaced_by) {
            await client.query(
              `UPDATE refresh_tokens SET revoked_at = $2
               WHERE user_id = $1 AND revoked_at IS NULL`,
              [current.user_id, now.toISOString()],
            );
            await client.query("COMMIT");
            return { status: "reuse" };
          }
          await client.query("ROLLBACK");
          return { status: "invalid" };
        }
        if (new Date(current.expires_at).getTime() <= now.getTime()) {
          await client.query("ROLLBACK");
          return { status: "invalid" };
        }
        const userResult = await client.query<UserRow>(
          `SELECT id, email, email_verified, name, picture FROM users WHERE id = $1`,
          [current.user_id],
        );
        const user = userResult.rows[0];
        if (!user) {
          await client.query("ROLLBACK");
          return { status: "invalid" };
        }
        await client.query(
          `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, revoked_at, replaced_by, created_at)
           VALUES ($1, $2, $3, $4, NULL, NULL, $5)`,
          [next.id, current.user_id, next.tokenHash, next.expiresAt, next.createdAt],
        );
        await client.query(
          `UPDATE refresh_tokens SET revoked_at = $2, replaced_by = $3 WHERE id = $1`,
          [current.id, now.toISOString(), next.id],
        );
        await client.query("COMMIT");
        return { status: "ok", user: toPublic(user) };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async revokeRefreshToken(hash, userId, now) {
      const result = await pool.query(
        `UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, $3)
         WHERE token_hash = $1 AND user_id = $2`,
        [hash, userId, now.toISOString()],
      );
      return (result.rowCount ?? 0) > 0;
    },
    async revokeAllRefreshTokens(userId, now) {
      await pool.query(
        `UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, $2) WHERE user_id = $1`,
        [userId, now.toISOString()],
      );
    },
    async getUser(id) {
      const result = await pool.query<UserRow>(
        `SELECT id, email, email_verified, name, picture FROM users WHERE id = $1`,
        [id],
      );
      const row = result.rows[0];
      return row ? toPublic(row) : null;
    },
    async createStudySession(input: NewStudySession) {
      const session: StudySessionRecord = {
        id: randomUUID(),
        user_id: input.userId,
        goals: input.goals,
        duration_secs: input.durationSecs,
        modality: input.modality,
        started_at: input.startedAt,
        ended_at: null,
      };
      await pool.query(
        `INSERT INTO study_sessions (id, user_id, goals, duration_secs, modality, started_at, ended_at)
         VALUES ($1, $2, $3, $4, $5, $6, NULL)`,
        [
          session.id,
          session.user_id,
          session.goals,
          session.duration_secs,
          session.modality,
          session.started_at,
        ],
      );
      return session;
    },
    async getStudySession(sessionId, userId) {
      const result = await pool.query<SessionRow>(
        `SELECT id, user_id, goals, duration_secs, modality, started_at, ended_at
         FROM study_sessions WHERE id = $1 AND user_id = $2`,
        [sessionId, userId],
      );
      const row = result.rows[0];
      return row ? toSession(row) : null;
    },
    async listStudySessions(userId) {
      const result = await pool.query<SessionRow>(
        `SELECT id, user_id, goals, duration_secs, modality, started_at, ended_at
         FROM study_sessions WHERE user_id = $1
         ORDER BY started_at DESC`,
        [userId],
      );
      return result.rows.map(toSession);
    },
    async listSessionEvents(sessionId, userId) {
      const result = await pool.query<EventRow>(
        `SELECT id, session_id, user_id, type, at, payload
         FROM session_events
         WHERE session_id = $1 AND user_id = $2
         ORDER BY at ASC`,
        [sessionId, userId],
      );
      return result.rows.map(toEvent);
    },
    async appendSessionEvent(input: NewSessionEvent) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const found = await client.query<{ id: string }>(
          `SELECT id FROM study_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE`,
          [input.sessionId, input.userId],
        );
        if (!found.rows[0]) {
          await client.query("ROLLBACK");
          return null;
        }
        const event: SessionEventRecord = {
          id: randomUUID(),
          session_id: input.sessionId,
          user_id: input.userId,
          type: input.type,
          at: input.at,
          payload: input.payload,
        };
        await client.query(
          `INSERT INTO session_events (id, session_id, user_id, type, at, payload)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
          [
            event.id,
            event.session_id,
            event.user_id,
            event.type,
            event.at,
            JSON.stringify(event.payload),
          ],
        );
        if (input.type === "session_ended") {
          await client.query(
            `UPDATE study_sessions
             SET ended_at = CASE
               WHEN ended_at IS NULL OR $2::timestamptz < ended_at THEN $2::timestamptz
               ELSE ended_at
             END
             WHERE id = $1`,
            [input.sessionId, input.at],
          );
        }
        await client.query("COMMIT");
        return event;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}
