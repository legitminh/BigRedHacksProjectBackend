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
  study_memory JSONB,
  updated_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS study_memory JSONB;

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

CREATE TABLE IF NOT EXISTS session_notes (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users (id),
  session_id TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NOT NULL,
  goals TEXT NOT NULL,
  kind TEXT NOT NULL,
  markdown TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (user_id, session_id)
);

CREATE INDEX IF NOT EXISTS session_notes_user_ended_idx
  ON session_notes (user_id, ended_at DESC);

CREATE TABLE IF NOT EXISTS drive_file_cache (
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  file_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  modified_time TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  kind TEXT,
  extracted_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, file_id)
);

CREATE INDEX IF NOT EXISTS drive_file_cache_user_extracted_idx
  ON drive_file_cache (user_id, extracted_at);

CREATE TABLE IF NOT EXISTS school_digests (
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  digest_date DATE NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  model TEXT NOT NULL,
  digest_text TEXT NOT NULL,
  sources_json JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  manual_refresh_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, digest_date)
);

ALTER TABLE school_digests ADD COLUMN IF NOT EXISTS manual_refresh_at TIMESTAMPTZ;
