CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  google_sub TEXT UNIQUE,
  email TEXT,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  name TEXT,
  picture TEXT,
  google_refresh_token TEXT,
  calendar_connected BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL,
  last_login_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS calendar_connected BOOLEAN NOT NULL DEFAULT FALSE;

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

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id UUID PRIMARY KEY REFERENCES users (id),
  interests TEXT[] NOT NULL DEFAULT '{}',
  long_term_goals JSONB NOT NULL DEFAULT '[]',
  priorities JSONB NOT NULL DEFAULT '[]',
  interaction JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS proficiencies (
  user_id UUID NOT NULL REFERENCES users (id),
  topic TEXT NOT NULL,
  level TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, topic)
);

CREATE TABLE IF NOT EXISTS pace_samples (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users (id),
  topic TEXT NOT NULL,
  problem TEXT NOT NULL,
  planned_minutes INTEGER NOT NULL,
  actual_minutes INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  task_id TEXT,
  recorded_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users (id),
  title TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  planned_minutes INTEGER NOT NULL,
  deadline_event_id TEXT,
  outcome TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS session_recaps (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users (id),
  task_id TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NOT NULL,
  break_minutes INTEGER NOT NULL,
  attention TEXT NOT NULL,
  note TEXT NOT NULL
);
