import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Pool, type PoolClient } from "pg";

import { canonicalEmail } from "../auth/email.ts";
import { hashesMatch } from "../auth/tokens.ts";
import { legacyGoogleToolConnections } from "../tools/catalog.ts";
import {
  clipCachedText,
  driveCacheEvictFileIds,
  type DriveCachedFile,
} from "../drive/cache.ts";
import {
  DEFAULT_INTERACTION,
  type Interaction,
  type Level,
  type PaceSample,
  type SessionNote,
  type SessionRecap,
  type StoredProfile,
  type StudyMemoryBlob,
  type TaskRecord,
} from "../product/model.ts";
import type {
  AdminBrowseResult,
  AdminBrowseTable,
  AdminOverview,
  AdminUserDetail,
  EmailLoginCode,
  GoogleProfile,
  PublicUser,
  RotateResult,
  SchoolDigest,
  SchoolDigestSource,
  Store,
  StoredRefreshToken,
  ToolConnection,
  ToolConnectionWrite,
} from "./types.ts";

type UserRow = {
  id: string;
  email: string | null;
  email_verified: boolean;
  name: string | null;
  picture: string | null;
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

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

function mapDriveCacheRow(row: {
  user_id: string;
  file_id: string;
  name: string;
  mime_type: string;
  modified_time: string;
  text: string;
  kind: string | null;
  extracted_at: Date;
}): DriveCachedFile {
  return {
    userId: row.user_id,
    fileId: row.file_id,
    name: row.name,
    mimeType: row.mime_type,
    modifiedTime: row.modified_time,
    text: row.text,
    kind: row.kind ?? undefined,
    extractedAt: new Date(row.extracted_at).toISOString(),
  };
}

const SCHOOL_DIGEST_MAX_TEXT = 80_000;

function clipSchoolDigestText(text: string): string {
  if (text.length <= SCHOOL_DIGEST_MAX_TEXT) return text;
  return `${text.slice(0, SCHOOL_DIGEST_MAX_TEXT - 1).trimEnd()}…`;
}

function mapSchoolDigestRow(row: {
  user_id: string;
  digest_date: Date;
  timezone: string;
  model: string;
  digest_text: string;
  sources_json: SchoolDigestSource[] | string;
  created_at: Date;
  updated_at: Date;
}): SchoolDigest {
  const digestDate =
    row.digest_date instanceof Date
      ? row.digest_date.toISOString().slice(0, 10)
      : String(row.digest_date).slice(0, 10);
  const sources =
    typeof row.sources_json === "string"
      ? (JSON.parse(row.sources_json) as SchoolDigestSource[])
      : row.sources_json;
  return {
    userId: row.user_id,
    digestDate,
    timezone: row.timezone,
    model: row.model,
    digestText: row.digest_text,
    sources: Array.isArray(sources) ? sources : [],
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

const userReturning = `RETURNING id, email, email_verified, name, picture`;

function postgresPoolConfig(databaseUrl: string): ConstructorParameters<typeof Pool>[0] {
  // pg treats sslmode=require as verify-full and ignores a separate ssl object.
  // Strip sslmode from the URL and pass explicit TLS for managed Tiger/Timescale.
  const wantsSsl = /[?&]sslmode=/i.test(databaseUrl);
  const connectionString = databaseUrl
    .replace(/([?&])sslmode=[^&]*/i, "$1")
    .replace(/[?&]$/, "")
    .replace(/\?&/, "?")
    .replace(/&&+/g, "&");
  return {
    connectionString,
    ...(wantsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  };
}

export async function openPostgres(databaseUrl: string): Promise<Store> {
  const pool = new Pool(postgresPoolConfig(databaseUrl));
  const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "../db/schema.sql");
  const schema = readFileSync(schemaPath, "utf8");
  for (const statement of schema
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)) {
    await pool.query(statement);
  }

  async function applyGoogleProfile(
    client: PoolClient,
    id: string,
    profile: GoogleProfile,
    email: string | null,
    now: Date,
  ): Promise<PublicUser> {
    const current = await client.query<{ calendar_connected: boolean; google_refresh_token: string | null }>(
      `SELECT calendar_connected, google_refresh_token FROM users WHERE id = $1`,
      [id],
    );
    const legacy = current.rows[0];
    const existingTools = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM tool_connections WHERE user_id = $1`,
      [id],
    );
    if (legacy?.calendar_connected && legacy.google_refresh_token && Number(existingTools.rows[0]?.n ?? 0) === 0) {
      for (const connection of legacyGoogleToolConnections(id, legacy.google_refresh_token, now.toISOString())) {
        await upsertToolRow(client, id, connection);
      }
    }
    const result = await client.query<UserRow>(
      `UPDATE users SET
         google_sub = $2,
         email = $3,
         email_verified = $4,
         name = $5,
         picture = $6,
         google_refresh_token = COALESCE($7, google_refresh_token),
         last_login_at = $8
       WHERE id = $1
       ${userReturning}`,
      [
        id,
        profile.sub,
        email,
        profile.emailVerified,
        profile.name,
        profile.picture,
        profile.googleRefreshToken,
        now.toISOString(),
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("User update returned no row.");
    return toPublic(row);
  }

  async function upsertGoogleOnce(profile: GoogleProfile, email: string | null, now: Date): Promise<PublicUser> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const bySub = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE google_sub = $1 FOR UPDATE`,
        [profile.sub],
      );
      const matched = bySub.rows[0];
      if (matched) {
        const user = await applyGoogleProfile(client, matched.id, profile, email, now);
        await client.query("COMMIT");
        return user;
      }
      if (email) {
        const byEmail = await client.query<{ id: string }>(
          `SELECT id FROM users WHERE lower(email) = $1 FOR UPDATE`,
          [email],
        );
        const linked = byEmail.rows[0];
        if (linked) {
          const user = await applyGoogleProfile(client, linked.id, profile, email, now);
          await client.query("COMMIT");
          return user;
        }
      }
      const inserted = await client.query<UserRow>(
        `INSERT INTO users (
           id, google_sub, email, email_verified, name, picture, google_refresh_token, created_at, last_login_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
         ${userReturning}`,
        [
          randomUUID(),
          profile.sub,
          email,
          profile.emailVerified,
          profile.name,
          profile.picture,
          profile.googleRefreshToken,
          now.toISOString(),
        ],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error("User upsert returned no row.");
      await client.query("COMMIT");
      return toPublic(row);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    kind: "postgres",
    async upsertGoogleUser(profile: GoogleProfile, now: Date) {
      const email = canonicalEmail(profile.email);
      try {
        return await upsertGoogleOnce(profile, email, now);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        return upsertGoogleOnce(profile, email, now);
      }
    },
    async findOrCreateUserByEmail(email: string, now: Date) {
      const canonical = canonicalEmail(email);
      if (!canonical) throw new Error("Email is required.");
      const existing = await pool.query<UserRow>(
        `UPDATE users SET email = $2, email_verified = TRUE, last_login_at = $3
         WHERE lower(email) = $1
         ${userReturning}`,
        [canonical, canonical, now.toISOString()],
      );
      const row = existing.rows[0];
      if (row) return toPublic(row);
      try {
        const inserted = await pool.query<UserRow>(
          `INSERT INTO users (
             id, google_sub, email, email_verified, name, picture, google_refresh_token, created_at, last_login_at
           ) VALUES ($1, NULL, $2, TRUE, NULL, NULL, NULL, $3, $3)
           ${userReturning}`,
          [randomUUID(), canonical, now.toISOString()],
        );
        const created = inserted.rows[0];
        if (!created) throw new Error("User insert returned no row.");
        return toPublic(created);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const again = await pool.query<UserRow>(
          `UPDATE users SET email = $2, email_verified = TRUE, last_login_at = $3
           WHERE lower(email) = $1
           ${userReturning}`,
          [canonical, canonical, now.toISOString()],
        );
        const linked = again.rows[0];
        if (!linked) throw error;
        return toPublic(linked);
      }
    },
    async replaceEmailLoginCode(code: EmailLoginCode) {
      const email = canonicalEmail(code.email);
      if (!email) throw new Error("Email is required.");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`DELETE FROM email_login_codes WHERE lower(email) = $1`, [email]);
        await client.query(
          `INSERT INTO email_login_codes (id, email, code_hash, expires_at, consumed_at, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [code.id, email, code.codeHash, code.expiresAt, code.consumedAt, code.createdAt],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async consumeEmailLoginCode(email: string, codeHash: string, now: Date) {
      const canonical = canonicalEmail(email);
      if (!canonical) return false;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const found = await client.query<{ id: string; code_hash: string; expires_at: Date }>(
          `SELECT id, code_hash, expires_at
           FROM email_login_codes
           WHERE lower(email) = $1 AND consumed_at IS NULL
           ORDER BY created_at DESC
           LIMIT 1
           FOR UPDATE`,
          [canonical],
        );
        const row = found.rows[0];
        if (!row || !hashesMatch(row.code_hash, codeHash) || new Date(row.expires_at).getTime() <= now.getTime()) {
          await client.query("ROLLBACK");
          return false;
        }
        const updated = await client.query(
          `UPDATE email_login_codes SET consumed_at = $2 WHERE id = $1 AND consumed_at IS NULL`,
          [row.id, now.toISOString()],
        );
        await client.query("COMMIT");
        return (updated.rowCount ?? 0) > 0;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
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
    async adminOverview(): Promise<AdminOverview> {
      const [counts, users] = await Promise.all([
        pool.query<{
          users: string;
          sessions: string;
          tasks: string;
          tokens: string;
          pace: string;
          proficiencies: string;
          profiles: string;
          email_codes: string;
          drive_cache: string;
          school_digests: string;
        }>(
          `SELECT
             (SELECT COUNT(*)::text FROM users) AS users,
             (SELECT COUNT(*)::text FROM session_recaps) AS sessions,
             (SELECT COUNT(*)::text FROM tasks) AS tasks,
             (SELECT COUNT(*)::text FROM refresh_tokens
               WHERE revoked_at IS NULL AND expires_at > NOW()) AS tokens,
             (SELECT COUNT(*)::text FROM pace_samples) AS pace,
             (SELECT COUNT(*)::text FROM proficiencies) AS proficiencies,
             (SELECT COUNT(*)::text FROM user_profiles) AS profiles,
             (SELECT COUNT(*)::text FROM email_login_codes) AS email_codes,
             (SELECT COUNT(*)::text FROM drive_file_cache) AS drive_cache,
             (SELECT COUNT(*)::text FROM school_digests) AS school_digests`,
        ),
        pool.query<{
          id: string;
          email: string | null;
          name: string | null;
          created_at: Date;
          last_login_at: Date;
          calendar_connected: boolean;
        }>(
          `SELECT id, email, name, created_at, last_login_at, calendar_connected
           FROM users
           ORDER BY last_login_at DESC
           LIMIT 100`,
        ),
      ]);
      const row = counts.rows[0];
      return {
        storage: "postgres",
        userCount: Number(row?.users ?? 0),
        sessionCount: Number(row?.sessions ?? 0),
        taskCount: Number(row?.tasks ?? 0),
        paceCount: Number(row?.pace ?? 0),
        proficiencyCount: Number(row?.proficiencies ?? 0),
        profileCount: Number(row?.profiles ?? 0),
        emailCodeCount: Number(row?.email_codes ?? 0),
        activeRefreshTokens: Number(row?.tokens ?? 0),
        driveCacheCount: Number(row?.drive_cache ?? 0),
        schoolDigestCount: Number(row?.school_digests ?? 0),
        users: users.rows.map((u) => ({
          id: u.id,
          email: u.email,
          name: u.name,
          created_at: new Date(u.created_at).toISOString(),
          last_login_at: new Date(u.last_login_at).toISOString(),
          calendar_connected: u.calendar_connected,
        })),
      };
    },
    async adminUserDetail(userId): Promise<AdminUserDetail | null> {
      const userResult = await pool.query<{
        id: string;
        email: string | null;
        email_verified: boolean;
        name: string | null;
        picture: string | null;
        google_sub: string | null;
        created_at: Date;
        last_login_at: Date;
        calendar_connected: boolean;
        has_refresh: boolean;
      }>(
        `SELECT id, email, email_verified, name, picture, google_sub,
                created_at, last_login_at, calendar_connected,
                (google_refresh_token IS NOT NULL) AS has_refresh
         FROM users WHERE id = $1`,
        [userId],
      );
      const u = userResult.rows[0];
      if (!u) return null;
      const [profile, proficiencies, pace, tasks, sessions, driveCache, digests, tokens] =
        await Promise.all([
          this.getProfile(userId),
          this.listProficiencies(userId),
          this.listPaceSamples(userId, null),
          pool.query(
            `SELECT id, title, mode, status, planned_minutes, deadline_event_id, outcome, started_at, ended_at
             FROM tasks WHERE user_id = $1 ORDER BY started_at DESC LIMIT 200`,
            [userId],
          ),
          this.listSessions(userId),
          this.listDriveFileCache(userId),
          pool.query<{
            digest_date: Date;
            timezone: string;
            model: string;
            digest_text: string;
            sources_json: SchoolDigestSource[] | string;
            created_at: Date;
            updated_at: Date;
          }>(
            `SELECT digest_date, timezone, model, digest_text, sources_json, created_at, updated_at
             FROM school_digests WHERE user_id = $1
             ORDER BY digest_date DESC LIMIT 60`,
            [userId],
          ),
          pool.query<{ total: string; active: string; revoked: string }>(
            `SELECT
               COUNT(*)::text AS total,
               COUNT(*) FILTER (WHERE revoked_at IS NULL AND expires_at > NOW())::text AS active,
               COUNT(*) FILTER (WHERE revoked_at IS NOT NULL)::text AS revoked
             FROM refresh_tokens WHERE user_id = $1`,
            [userId],
          ),
        ]);
      const tokenRow = tokens.rows[0];
      return {
        user: {
          id: u.id,
          email: u.email,
          email_verified: u.email_verified,
          name: u.name,
          picture: u.picture,
          google_sub: u.google_sub,
          created_at: new Date(u.created_at).toISOString(),
          last_login_at: new Date(u.last_login_at).toISOString(),
          calendar_connected: u.calendar_connected,
          has_google_refresh_token: u.has_refresh,
        },
        profile,
        proficiencies,
        pace,
        tasks: tasks.rows.map((row) => ({
          id: String(row.id),
          title: String(row.title),
          mode: row.mode as TaskRecord["mode"],
          status: row.status as TaskRecord["status"],
          planned_minutes: Number(row.planned_minutes),
          deadline_event_id: (row.deadline_event_id as string | null) ?? null,
          outcome: (row.outcome as TaskRecord["outcome"]) ?? null,
          started_at: new Date(row.started_at as Date).toISOString(),
          ended_at: row.ended_at ? new Date(row.ended_at as Date).toISOString() : null,
        })),
        sessions,
        driveCache: driveCache.map((row) => ({
          file_id: row.fileId,
          name: row.name,
          mime_type: row.mimeType,
          modified_time: row.modifiedTime,
          kind: row.kind ?? null,
          text_chars: row.text.length,
          text_preview: row.text.slice(0, 160),
          extracted_at: row.extractedAt,
        })),
        schoolDigests: digests.rows.map((row) => {
          const mapped = mapSchoolDigestRow({
            user_id: userId,
            digest_date: row.digest_date,
            timezone: row.timezone,
            model: row.model,
            digest_text: row.digest_text,
            sources_json: row.sources_json,
            created_at: row.created_at,
            updated_at: row.updated_at,
          });
          return {
            digest_date: mapped.digestDate,
            timezone: mapped.timezone,
            model: mapped.model,
            digest_text: mapped.digestText,
            sources: mapped.sources,
            text_chars: mapped.digestText.length,
            created_at: mapped.createdAt,
            updated_at: mapped.updatedAt,
          };
        }),
        tokens: {
          total: Number(tokenRow?.total ?? 0),
          active: Number(tokenRow?.active ?? 0),
          revoked: Number(tokenRow?.revoked ?? 0),
        },
      };
    },
    async adminBrowse(table: AdminBrowseTable, limit = 200): Promise<AdminBrowseResult> {
      const cap = Math.min(500, Math.max(1, limit));
      const pack = (count: number, rows: Record<string, unknown>[]): AdminBrowseResult => ({
        table,
        count,
        truncated: count > rows.length,
        rows,
      });
      switch (table) {
        case "users": {
          const result = await pool.query(
            `SELECT id, email, name, email_verified, google_sub, calendar_connected,
                    (google_refresh_token IS NOT NULL) AS has_google_refresh_token,
                    created_at, last_login_at
             FROM users ORDER BY last_login_at DESC LIMIT $1`,
            [cap],
          );
          const total = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM users`);
          return pack(
            Number(total.rows[0]?.n ?? 0),
            result.rows.map((r) => ({
              ...r,
              created_at: new Date(r.created_at as Date).toISOString(),
              last_login_at: new Date(r.last_login_at as Date).toISOString(),
            })),
          );
        }
        case "tasks": {
          const result = await pool.query(
            `SELECT id, user_id, title, mode, status, planned_minutes, deadline_event_id,
                    outcome, started_at, ended_at
             FROM tasks ORDER BY started_at DESC LIMIT $1`,
            [cap],
          );
          const total = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM tasks`);
          return pack(
            Number(total.rows[0]?.n ?? 0),
            result.rows.map((r) => ({
              ...r,
              started_at: new Date(r.started_at as Date).toISOString(),
              ended_at: r.ended_at ? new Date(r.ended_at as Date).toISOString() : null,
            })),
          );
        }
        case "sessions": {
          const result = await pool.query(
            `SELECT id, user_id, task_id, started_at, ended_at, break_minutes, attention, note
             FROM session_recaps ORDER BY ended_at DESC LIMIT $1`,
            [cap],
          );
          const total = await pool.query<{ n: string }>(
            `SELECT COUNT(*)::text AS n FROM session_recaps`,
          );
          return pack(
            Number(total.rows[0]?.n ?? 0),
            result.rows.map((r) => ({
              ...r,
              started_at: new Date(r.started_at as Date).toISOString(),
              ended_at: new Date(r.ended_at as Date).toISOString(),
            })),
          );
        }
        case "session_notes": {
          const result = await pool.query(
            `SELECT id, user_id, session_id, started_at, ended_at, goals, kind,
                    char_length(markdown) AS markdown_chars, created_at
             FROM session_notes ORDER BY ended_at DESC LIMIT $1`,
            [cap],
          );
          const total = await pool.query<{ n: string }>(
            `SELECT COUNT(*)::text AS n FROM session_notes`,
          );
          return pack(
            Number(total.rows[0]?.n ?? 0),
            result.rows.map((r) => ({
              ...r,
              started_at: new Date(r.started_at as Date).toISOString(),
              ended_at: new Date(r.ended_at as Date).toISOString(),
              created_at: new Date(r.created_at as Date).toISOString(),
              markdown_chars: Number(r.markdown_chars),
            })),
          );
        }
        case "pace": {
          const result = await pool.query(
            `SELECT id, user_id, topic, problem, planned_minutes, actual_minutes, outcome, task_id, recorded_at
             FROM pace_samples ORDER BY recorded_at DESC LIMIT $1`,
            [cap],
          );
          const total = await pool.query<{ n: string }>(
            `SELECT COUNT(*)::text AS n FROM pace_samples`,
          );
          return pack(
            Number(total.rows[0]?.n ?? 0),
            result.rows.map((r) => ({
              ...r,
              recorded_at: new Date(r.recorded_at as Date).toISOString(),
            })),
          );
        }
        case "proficiencies": {
          const result = await pool.query(
            `SELECT user_id, topic, level, updated_at FROM proficiencies
             ORDER BY updated_at DESC LIMIT $1`,
            [cap],
          );
          const total = await pool.query<{ n: string }>(
            `SELECT COUNT(*)::text AS n FROM proficiencies`,
          );
          return pack(
            Number(total.rows[0]?.n ?? 0),
            result.rows.map((r) => ({
              ...r,
              updated_at: new Date(r.updated_at as Date).toISOString(),
            })),
          );
        }
        case "profiles": {
          const result = await pool.query(
            `SELECT user_id, interests, long_term_goals, priorities, interaction,
                    (study_memory IS NOT NULL) AS has_study_memory, updated_at
             FROM user_profiles ORDER BY updated_at DESC LIMIT $1`,
            [cap],
          );
          const total = await pool.query<{ n: string }>(
            `SELECT COUNT(*)::text AS n FROM user_profiles`,
          );
          return pack(
            Number(total.rows[0]?.n ?? 0),
            result.rows.map((r) => ({
              ...r,
              updated_at: new Date(r.updated_at as Date).toISOString(),
            })),
          );
        }
        case "drive_cache": {
          const result = await pool.query<{
            user_id: string;
            file_id: string;
            name: string;
            mime_type: string;
            modified_time: string;
            kind: string | null;
            text: string;
            extracted_at: Date;
          }>(
            `SELECT user_id, file_id, name, mime_type, modified_time, kind, text, extracted_at
             FROM drive_file_cache ORDER BY extracted_at DESC LIMIT $1`,
            [cap],
          );
          const total = await pool.query<{ n: string }>(
            `SELECT COUNT(*)::text AS n FROM drive_file_cache`,
          );
          return pack(
            Number(total.rows[0]?.n ?? 0),
            result.rows.map((r) => ({
              user_id: r.user_id,
              file_id: r.file_id,
              name: r.name,
              mime_type: r.mime_type,
              kind: r.kind,
              modified_time: r.modified_time,
              text_chars: r.text.length,
              text_preview: r.text.slice(0, 120),
              extracted_at: new Date(r.extracted_at).toISOString(),
            })),
          );
        }
        case "school_digests": {
          const result = await pool.query<{
            user_id: string;
            digest_date: Date;
            timezone: string;
            model: string;
            digest_text: string;
            sources_json: SchoolDigestSource[] | string;
            created_at: Date;
            updated_at: Date;
          }>(
            `SELECT user_id, digest_date, timezone, model, digest_text, sources_json, created_at, updated_at
             FROM school_digests ORDER BY digest_date DESC LIMIT $1`,
            [cap],
          );
          const total = await pool.query<{ n: string }>(
            `SELECT COUNT(*)::text AS n FROM school_digests`,
          );
          return pack(
            Number(total.rows[0]?.n ?? 0),
            result.rows.map((r) => {
              const mapped = mapSchoolDigestRow(r);
              return {
                user_id: r.user_id,
                digest_date: mapped.digestDate,
                timezone: mapped.timezone,
                model: mapped.model,
                sources: mapped.sources,
                source_count: mapped.sources.length,
                text_chars: mapped.digestText.length,
                text_preview: mapped.digestText.slice(0, 120),
                created_at: mapped.createdAt,
                updated_at: mapped.updatedAt,
              };
            }),
          );
        }
        case "email_codes": {
          const result = await pool.query(
            `SELECT id, email, expires_at, consumed_at, created_at,
                    (code_hash IS NOT NULL) AS has_code_hash
             FROM email_login_codes ORDER BY created_at DESC LIMIT $1`,
            [cap],
          );
          const total = await pool.query<{ n: string }>(
            `SELECT COUNT(*)::text AS n FROM email_login_codes`,
          );
          return pack(
            Number(total.rows[0]?.n ?? 0),
            result.rows.map((r) => ({
              id: r.id,
              email: r.email,
              expires_at: new Date(r.expires_at as Date).toISOString(),
              consumed_at: r.consumed_at ? new Date(r.consumed_at as Date).toISOString() : null,
              created_at: new Date(r.created_at as Date).toISOString(),
              has_code_hash: r.has_code_hash,
            })),
          );
        }
        case "refresh_tokens": {
          const result = await pool.query(
            `SELECT id, user_id, expires_at, revoked_at, created_at,
                    (revoked_at IS NULL AND expires_at > NOW()) AS active
             FROM refresh_tokens ORDER BY created_at DESC LIMIT $1`,
            [cap],
          );
          const total = await pool.query<{ n: string }>(
            `SELECT COUNT(*)::text AS n FROM refresh_tokens`,
          );
          return pack(
            Number(total.rows[0]?.n ?? 0),
            result.rows.map((r) => ({
              id: r.id,
              user_id: r.user_id,
              expires_at: new Date(r.expires_at as Date).toISOString(),
              revoked_at: r.revoked_at ? new Date(r.revoked_at as Date).toISOString() : null,
              created_at: new Date(r.created_at as Date).toISOString(),
              active: r.active,
            })),
          );
        }
        default:
          return { table, count: 0, truncated: false, rows: [] };
      }
    },
    async getUser(id) {
      const result = await pool.query<UserRow>(
        `SELECT id, email, email_verified, name, picture FROM users WHERE id = $1`,
        [id],
      );
      const row = result.rows[0];
      return row ? toPublic(row) : null;
    },
    async getProfile(userId) {
      const result = await pool.query<{
        interests: string[];
        long_term_goals: unknown;
        priorities: unknown;
        interaction: unknown;
        study_memory: unknown;
        updated_at: Date;
      }>(
        `SELECT interests, long_term_goals, priorities, interaction, study_memory, updated_at
         FROM user_profiles WHERE user_id = $1`,
        [userId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        interests: row.interests ?? [],
        long_term_goals: asStrings(row.long_term_goals),
        priorities: asStrings(row.priorities),
        interaction: asInteraction(row.interaction),
        study_memory: asStudyMemory(row.study_memory),
        updated_at: new Date(row.updated_at).toISOString(),
      };
    },
    async saveProfile(userId, profile: StoredProfile) {
      await pool.query(
        `INSERT INTO user_profiles (user_id, interests, long_term_goals, priorities, interaction, study_memory, updated_at)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7)
         ON CONFLICT (user_id) DO UPDATE SET
           interests = EXCLUDED.interests,
           long_term_goals = EXCLUDED.long_term_goals,
           priorities = EXCLUDED.priorities,
           interaction = EXCLUDED.interaction,
           study_memory = EXCLUDED.study_memory,
           updated_at = EXCLUDED.updated_at`,
        [
          userId,
          profile.interests,
          JSON.stringify(profile.long_term_goals),
          JSON.stringify(profile.priorities),
          JSON.stringify(profile.interaction),
          profile.study_memory ? JSON.stringify(profile.study_memory) : null,
          profile.updated_at,
        ],
      );
    },
    async listProficiencies(userId) {
      const result = await pool.query<{ topic: string; level: Level }>(
        `SELECT topic, level FROM proficiencies WHERE user_id = $1 ORDER BY topic`,
        [userId],
      );
      return result.rows;
    },
    async replaceProficiencies(userId, items, now) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`DELETE FROM proficiencies WHERE user_id = $1`, [userId]);
        for (const item of items) {
          await client.query(
            `INSERT INTO proficiencies (user_id, topic, level, updated_at) VALUES ($1, $2, $3, $4)`,
            [userId, item.topic, item.level, now.toISOString()],
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async upsertProficiency(userId, item, now) {
      await pool.query(
        `DELETE FROM proficiencies WHERE user_id = $1 AND lower(topic) = lower($2)`,
        [userId, item.topic],
      );
      await pool.query(
        `INSERT INTO proficiencies (user_id, topic, level, updated_at) VALUES ($1, $2, $3, $4)`,
        [userId, item.topic, item.level, now.toISOString()],
      );
    },
    async addPaceSample(userId, sample) {
      await pool.query(
        `INSERT INTO pace_samples (id, user_id, topic, problem, planned_minutes, actual_minutes, outcome, task_id, recorded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          sample.id,
          userId,
          sample.topic,
          sample.problem,
          sample.planned_minutes,
          sample.actual_minutes,
          sample.outcome,
          sample.task_id,
          sample.recorded_at,
        ],
      );
      return sample;
    },
    async listPaceSamples(userId, topic) {
      const result = await pool.query<PaceSample>(
        `SELECT id, topic, problem, planned_minutes, actual_minutes, outcome, task_id, recorded_at
         FROM pace_samples
         WHERE user_id = $1 AND ($2::text IS NULL OR lower(topic) = lower($2))
         ORDER BY recorded_at DESC`,
        [userId, topic],
      );
      return result.rows.map((row) => ({
        ...row,
        recorded_at: new Date(row.recorded_at).toISOString(),
      }));
    },
    async getCalendarConnection(userId) {
      const result = await pool.query<{ calendar_connected: boolean; google_refresh_token: string | null }>(
        `SELECT calendar_connected, google_refresh_token FROM users WHERE id = $1`,
        [userId],
      );
      const row = result.rows[0];
      if (!row) return { connected: false, refreshToken: null };
      return { connected: row.calendar_connected, refreshToken: row.google_refresh_token };
    },
    async setCalendarGrant(userId, refreshToken, connected) {
      if (refreshToken) {
        await pool.query(
          `UPDATE users SET calendar_connected = $2, google_refresh_token = $3 WHERE id = $1`,
          [userId, connected, refreshToken],
        );
        return;
      }
      if (!connected) {
        await pool.query(
          `UPDATE users SET calendar_connected = false, google_refresh_token = NULL WHERE id = $1`,
          [userId],
        );
        return;
      }
      await pool.query(`UPDATE users SET calendar_connected = $2 WHERE id = $1`, [userId, connected]);
    },
    async listToolConnections(userId) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const user = await client.query<{ calendar_connected: boolean; google_refresh_token: string | null }>(
          `SELECT calendar_connected, google_refresh_token FROM users WHERE id = $1 FOR UPDATE`,
          [userId],
        );
        let rows = (
          await client.query<ToolConnectionRow>(
            `SELECT user_id, tool_id, provider, scopes, refresh_token, status, connected_at, updated_at
             FROM tool_connections WHERE user_id = $1`,
            [userId],
          )
        ).rows;
        const legacy = user.rows[0];
        if (rows.length === 0 && legacy?.calendar_connected && legacy.google_refresh_token) {
          const nowIso = new Date().toISOString();
          for (const connection of legacyGoogleToolConnections(userId, legacy.google_refresh_token, nowIso)) {
            await upsertToolRow(client, userId, connection);
          }
          rows = (
            await client.query<ToolConnectionRow>(
              `SELECT user_id, tool_id, provider, scopes, refresh_token, status, connected_at, updated_at
               FROM tool_connections WHERE user_id = $1`,
              [userId],
            )
          ).rows;
        }
        await client.query("COMMIT");
        return rows.map(mapToolConnection);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async upsertToolConnection(userId, connection: ToolConnectionWrite) {
      await upsertToolRow(pool, userId, { userId, ...connection });
    },
    async disconnectTool(userId, toolId) {
      await pool.query(
        `UPDATE tool_connections
         SET refresh_token = NULL, status = 'disconnected', updated_at = $3
         WHERE user_id = $1 AND tool_id = $2`,
        [userId, toolId, new Date().toISOString()],
      );
    },
    async createTask(userId, task, now) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `UPDATE tasks SET status = 'dropped', ended_at = $2 WHERE user_id = $1 AND status = 'active'`,
          [userId, now.toISOString()],
        );
        await client.query(
          `INSERT INTO tasks (id, user_id, title, mode, status, planned_minutes, deadline_event_id, outcome, started_at, ended_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            task.id,
            userId,
            task.title,
            task.mode,
            task.status,
            task.planned_minutes,
            task.deadline_event_id,
            task.outcome,
            task.started_at,
            task.ended_at,
          ],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      return task;
    },
    async getActiveTask(userId) {
      const result = await pool.query<TaskRow>(
        `SELECT id, title, mode, status, planned_minutes, deadline_event_id, outcome, started_at, ended_at
         FROM tasks WHERE user_id = $1 AND status = 'active' LIMIT 1`,
        [userId],
      );
      return result.rows[0] ? mapTask(result.rows[0]) : null;
    },
    async getTask(userId, id) {
      const result = await pool.query<TaskRow>(
        `SELECT id, title, mode, status, planned_minutes, deadline_event_id, outcome, started_at, ended_at
         FROM tasks WHERE user_id = $1 AND id = $2`,
        [userId, id],
      );
      return result.rows[0] ? mapTask(result.rows[0]) : null;
    },
    async saveTask(userId, task) {
      await pool.query(
        `UPDATE tasks SET title = $3, mode = $4, status = $5, planned_minutes = $6, deadline_event_id = $7,
           outcome = $8, started_at = $9, ended_at = $10
         WHERE user_id = $1 AND id = $2`,
        [
          userId,
          task.id,
          task.title,
          task.mode,
          task.status,
          task.planned_minutes,
          task.deadline_event_id,
          task.outcome,
          task.started_at,
          task.ended_at,
        ],
      );
    },
    async insertSession(userId, session) {
      await pool.query(
        `INSERT INTO session_recaps (id, user_id, task_id, started_at, ended_at, break_minutes, attention, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          session.id,
          userId,
          session.task_id,
          session.started_at,
          session.ended_at,
          session.break_minutes,
          session.attention,
          session.note,
        ],
      );
      return session;
    },
    async listSessions(userId) {
      const result = await pool.query<{
        id: string;
        task_id: string;
        started_at: Date;
        ended_at: Date;
        break_minutes: number;
        attention: SessionRecap["attention"];
        note: string;
      }>(
        `SELECT id, task_id, started_at, ended_at, break_minutes, attention, note
         FROM session_recaps WHERE user_id = $1 ORDER BY ended_at DESC`,
        [userId],
      );
      return result.rows.map((row) => ({
        id: row.id,
        task_id: row.task_id,
        started_at: new Date(row.started_at).toISOString(),
        ended_at: new Date(row.ended_at).toISOString(),
        break_minutes: row.break_minutes,
        attention: row.attention,
        note: row.note,
      }));
    },
    async upsertSessionNote(userId, note) {
      try {
        await pool.query(
          `INSERT INTO session_notes
             (id, user_id, session_id, started_at, ended_at, goals, kind, markdown, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            note.id,
            userId,
            note.session_id,
            note.started_at,
            note.ended_at,
            note.goals,
            note.kind,
            note.markdown,
            note.created_at,
          ],
        );
        return { note: { ...note, user_id: userId }, created: true };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
      const result = await pool.query<SessionNoteRow>(
        `UPDATE session_notes
           SET started_at = $3, ended_at = $4, goals = $5, kind = $6, markdown = $7
         WHERE user_id = $1 AND session_id = $2
         RETURNING id, user_id, session_id, started_at, ended_at, goals, kind, markdown, created_at`,
        [userId, note.session_id, note.started_at, note.ended_at, note.goals, note.kind, note.markdown],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Session note update returned no row.");
      return { note: mapSessionNote(row), created: false };
    },
    async listSessionNotes(userId, limit) {
      const cap = Math.min(50, Math.max(0, limit));
      const result = await pool.query<SessionNoteRow>(
        `SELECT id, user_id, session_id, started_at, ended_at, goals, kind, markdown, created_at
         FROM session_notes
         WHERE user_id = $1
         ORDER BY ended_at DESC, created_at DESC
         LIMIT $2`,
        [userId, cap],
      );
      return result.rows.map(mapSessionNote);
    },
    async getSessionNote(userId, id) {
      const result = await pool.query<SessionNoteRow>(
        `SELECT id, user_id, session_id, started_at, ended_at, goals, kind, markdown, created_at
         FROM session_notes
         WHERE user_id = $1 AND id = $2`,
        [userId, id],
      );
      const row = result.rows[0];
      return row ? mapSessionNote(row) : null;
    },
    async getDriveFileCache(userId, fileId) {
      const result = await pool.query<{
        user_id: string;
        file_id: string;
        name: string;
        mime_type: string;
        modified_time: string;
        text: string;
        kind: string | null;
        extracted_at: Date;
      }>(
        `SELECT user_id, file_id, name, mime_type, modified_time, text, kind, extracted_at
         FROM drive_file_cache WHERE user_id = $1 AND file_id = $2`,
        [userId, fileId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return mapDriveCacheRow(row);
    },
    async upsertDriveFileCache(entry) {
      const clipped: DriveCachedFile = { ...entry, text: clipCachedText(entry.text) };
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const existing = await client.query<{ file_id: string; extracted_at: Date }>(
          `SELECT file_id, extracted_at FROM drive_file_cache WHERE user_id = $1`,
          [entry.userId],
        );
        const forUser = existing.rows.map((row) => ({
          userId: entry.userId,
          fileId: row.file_id,
          name: "",
          mimeType: "",
          modifiedTime: "",
          text: "",
          extractedAt: new Date(row.extracted_at).toISOString(),
        }));
        const evict = driveCacheEvictFileIds(forUser, entry.fileId);
        if (evict.length > 0) {
          await client.query(
            `DELETE FROM drive_file_cache WHERE user_id = $1 AND file_id = ANY($2::text[])`,
            [entry.userId, evict],
          );
        }
        await client.query(
          `INSERT INTO drive_file_cache
             (user_id, file_id, name, mime_type, modified_time, text, kind, extracted_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (user_id, file_id) DO UPDATE SET
             name = EXCLUDED.name,
             mime_type = EXCLUDED.mime_type,
             modified_time = EXCLUDED.modified_time,
             text = EXCLUDED.text,
             kind = EXCLUDED.kind,
             extracted_at = EXCLUDED.extracted_at`,
          [
            clipped.userId,
            clipped.fileId,
            clipped.name,
            clipped.mimeType,
            clipped.modifiedTime,
            clipped.text,
            clipped.kind ?? null,
            clipped.extractedAt,
          ],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async listDriveFileCache(userId) {
      const result = await pool.query<{
        user_id: string;
        file_id: string;
        name: string;
        mime_type: string;
        modified_time: string;
        text: string;
        kind: string | null;
        extracted_at: Date;
      }>(
        `SELECT user_id, file_id, name, mime_type, modified_time, text, kind, extracted_at
         FROM drive_file_cache WHERE user_id = $1 ORDER BY extracted_at DESC`,
        [userId],
      );
      return result.rows.map(mapDriveCacheRow);
    },
    async clearDriveFileCache(userId) {
      await pool.query(`DELETE FROM drive_file_cache WHERE user_id = $1`, [userId]);
    },
    async getSchoolDigest(userId, digestDate) {
      const result = await pool.query<{
        user_id: string;
        digest_date: Date;
        timezone: string;
        model: string;
        digest_text: string;
        sources_json: SchoolDigestSource[];
        created_at: Date;
        updated_at: Date;
      }>(
        `SELECT user_id, digest_date, timezone, model, digest_text, sources_json, created_at, updated_at
         FROM school_digests WHERE user_id = $1 AND digest_date = $2::date`,
        [userId, digestDate],
      );
      const row = result.rows[0];
      if (!row) return null;
      return mapSchoolDigestRow(row);
    },
    async upsertSchoolDigest(digest) {
      const clipped = clipSchoolDigestText(digest.digestText);
      await pool.query(
        `INSERT INTO school_digests
           (user_id, digest_date, timezone, model, digest_text, sources_json, created_at, updated_at)
         VALUES ($1, $2::date, $3, $4, $5, $6::jsonb, $7::timestamptz, $8::timestamptz)
         ON CONFLICT (user_id, digest_date) DO UPDATE SET
           timezone = EXCLUDED.timezone,
           model = EXCLUDED.model,
           digest_text = EXCLUDED.digest_text,
           sources_json = EXCLUDED.sources_json,
           updated_at = EXCLUDED.updated_at`,
        [
          digest.userId,
          digest.digestDate,
          digest.timezone,
          digest.model,
          clipped,
          JSON.stringify(digest.sources),
          digest.createdAt,
          digest.updatedAt,
        ],
      );
    },
    async clearUserData(userId, _now) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const emailRow = await client.query<{ email: string | null }>(
          `SELECT email FROM users WHERE id = $1`,
          [userId],
        );
        const email = emailRow.rows[0]?.email?.trim().toLowerCase() ?? null;
        await client.query(`DELETE FROM drive_file_cache WHERE user_id = $1`, [userId]);
        await client.query(`DELETE FROM school_digests WHERE user_id = $1`, [userId]);
        await client.query(`DELETE FROM session_recaps WHERE user_id = $1`, [userId]);
        await client.query(`DELETE FROM session_notes WHERE user_id = $1`, [userId]);
        await client.query(`DELETE FROM tasks WHERE user_id = $1`, [userId]);
        await client.query(`DELETE FROM pace_samples WHERE user_id = $1`, [userId]);
        await client.query(`DELETE FROM proficiencies WHERE user_id = $1`, [userId]);
        await client.query(`DELETE FROM user_profiles WHERE user_id = $1`, [userId]);
        await client.query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [userId]);
        await client.query(`DELETE FROM tool_connections WHERE user_id = $1`, [userId]);
        if (email) {
          await client.query(`DELETE FROM email_login_codes WHERE lower(email) = $1`, [email]);
        }
        await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
        await client.query("COMMIT");
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

type ToolConnectionRow = {
  user_id: string;
  tool_id: string;
  provider: string;
  scopes: string;
  refresh_token: string | null;
  status: string;
  connected_at: Date | string | null;
  updated_at: Date | string;
};

function mapToolConnection(row: ToolConnectionRow): ToolConnection {
  return {
    userId: row.user_id,
    toolId: row.tool_id,
    provider: row.provider,
    scopes: row.scopes,
    refreshToken: row.refresh_token,
    status: row.status === "connected" ? "connected" : "disconnected",
    connectedAt: row.connected_at ? new Date(row.connected_at).toISOString() : null,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function upsertToolRow(
  db: Pick<Pool | PoolClient, "query">,
  userId: string,
  connection: ToolConnection,
): Promise<void> {
  await db.query(
    `INSERT INTO tool_connections (
       user_id, tool_id, provider, scopes, refresh_token, status, connected_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (user_id, tool_id) DO UPDATE SET
       provider = EXCLUDED.provider,
       scopes = EXCLUDED.scopes,
       refresh_token = EXCLUDED.refresh_token,
       status = EXCLUDED.status,
       connected_at = EXCLUDED.connected_at,
       updated_at = EXCLUDED.updated_at`,
    [
      userId,
      connection.toolId,
      connection.provider,
      connection.scopes,
      connection.refreshToken,
      connection.status,
      connection.connectedAt,
      connection.updatedAt,
    ],
  );
}

type TaskRow = {
  id: string;
  title: string;
  mode: TaskRecord["mode"];
  status: TaskRecord["status"];
  planned_minutes: number;
  deadline_event_id: string | null;
  outcome: TaskRecord["outcome"];
  started_at: Date | string;
  ended_at: Date | string | null;
};

type SessionNoteRow = {
  id: string;
  user_id: string;
  session_id: string;
  started_at: Date | string;
  ended_at: Date | string;
  goals: string;
  kind: SessionNote["kind"];
  markdown: string;
  created_at: Date | string;
};

function mapSessionNote(row: SessionNoteRow): SessionNote {
  return {
    id: row.id,
    user_id: row.user_id,
    session_id: row.session_id,
    started_at: new Date(row.started_at).toISOString(),
    ended_at: new Date(row.ended_at).toISOString(),
    goals: row.goals,
    kind: row.kind,
    markdown: row.markdown,
    created_at: new Date(row.created_at).toISOString(),
  };
}

function mapTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    title: row.title,
    mode: row.mode,
    status: row.status,
    planned_minutes: row.planned_minutes,
    deadline_event_id: row.deadline_event_id,
    outcome: row.outcome,
    started_at: new Date(row.started_at).toISOString(),
    ended_at: row.ended_at ? new Date(row.ended_at).toISOString() : null,
  };
}

function asStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function asInteraction(value: unknown): Interaction {
  if (!value || typeof value !== "object") return { ...DEFAULT_INTERACTION };
  return { ...DEFAULT_INTERACTION, ...(value as Partial<Interaction>) };
}

function asStudyMemory(value: unknown): StudyMemoryBlob | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as { narrative?: unknown; stats?: unknown; updated_at?: unknown };
  return {
    narrative: typeof row.narrative === "string" ? row.narrative : "",
    stats:
      row.stats && typeof row.stats === "object" && !Array.isArray(row.stats)
        ? (row.stats as Record<string, unknown>)
        : {},
    updated_at: typeof row.updated_at === "string" ? row.updated_at : new Date(0).toISOString(),
  };
}
