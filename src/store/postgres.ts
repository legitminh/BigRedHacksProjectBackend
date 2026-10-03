import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Pool, type PoolClient } from "pg";

import { canonicalEmail } from "../auth/email.ts";
import { hashesMatch } from "../auth/tokens.ts";
import type {
  EmailLoginCode,
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

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

const userReturning = `RETURNING id, email, email_verified, name, picture`;

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

  async function applyGoogleProfile(
    client: PoolClient,
    id: string,
    profile: GoogleProfile,
    email: string | null,
    now: Date,
  ): Promise<PublicUser> {
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
