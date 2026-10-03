import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";

import type {
  GoogleProfile,
  PublicUser,
  RotateResult,
  Store,
  StoredRefreshToken,
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
    async close() {
      await pool.end();
    },
  };
}
