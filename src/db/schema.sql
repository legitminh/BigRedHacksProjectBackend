CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  name TEXT,
  picture TEXT,
  google_refresh_token TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  last_login_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users (id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  replaced_by UUID,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS study_sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users (id),
  goals TEXT NOT NULL,
  duration_secs DOUBLE PRECISION NOT NULL,
  modality TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS session_events (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES study_sessions (id),
  user_id UUID NOT NULL REFERENCES users (id),
  type TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);
