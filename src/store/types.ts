export type PublicUser = {
  id: string;
  email: string | null;
  email_verified: boolean;
  name: string | null;
  picture: string | null;
};

export type GoogleProfile = {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
  googleRefreshToken: string | null;
};

export type StoredRefreshToken = {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  revokedAt: string | null;
  replacedBy: string | null;
  createdAt: string;
};

export type RotateResult =
  | { status: "ok"; user: PublicUser }
  | { status: "reuse" }
  | { status: "invalid" };

export type StudySessionRecord = {
  id: string;
  user_id: string;
  goals: string;
  duration_secs: number;
  modality: string;
  started_at: string;
  ended_at: string | null;
};

export type SessionEventRecord = {
  id: string;
  session_id: string;
  user_id: string;
  type: string;
  at: string;
  payload: Record<string, unknown>;
};

export type NewStudySession = {
  userId: string;
  goals: string;
  durationSecs: number;
  modality: string;
  startedAt: string;
};

export type NewSessionEvent = {
  sessionId: string;
  userId: string;
  type: string;
  at: string;
  payload: Record<string, unknown>;
};

export type Store = {
  kind: "file" | "postgres";
  upsertGoogleUser(profile: GoogleProfile, now: Date): Promise<PublicUser>;
  insertRefreshToken(token: StoredRefreshToken): Promise<void>;
  rotateRefreshToken(
    oldHash: string,
    next: StoredRefreshToken,
    now: Date,
  ): Promise<RotateResult>;
  revokeRefreshToken(hash: string, userId: string, now: Date): Promise<boolean>;
  revokeAllRefreshTokens(userId: string, now: Date): Promise<void>;
  getUser(id: string): Promise<PublicUser | null>;
  createStudySession(input: NewStudySession): Promise<StudySessionRecord>;
  getStudySession(sessionId: string, userId: string): Promise<StudySessionRecord | null>;
  listStudySessions(userId: string): Promise<StudySessionRecord[]>;
  listSessionEvents(sessionId: string, userId: string): Promise<SessionEventRecord[]>;
  appendSessionEvent(input: NewSessionEvent): Promise<SessionEventRecord | null>;
  close(): Promise<void>;
};
