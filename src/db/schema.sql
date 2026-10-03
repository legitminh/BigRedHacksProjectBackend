CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  google_sub TEXT UNIQUE,
  email TEXT,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  name TEXT,
  picture TEXT,
  google_refresh_token TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  last_login_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE users ALTER COLUMN google_sub DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uidx
  ON users (lower(email))
  WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users (id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  replaced_by UUID,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS email_login_codes (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL
);
