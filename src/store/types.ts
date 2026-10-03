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

import type {
  CalendarConnection,
  PaceSample,
  Proficiency,
  SessionRecap,
  StoredProfile,
  TaskRecord,
} from "../product/model.ts";

export type EmailLoginCode = {
  id: string;
  email: string;
  codeHash: string;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
};

export type Store = {
  kind: "file" | "postgres";
  upsertGoogleUser(profile: GoogleProfile, now: Date): Promise<PublicUser>;
  findOrCreateUserByEmail(email: string, now: Date): Promise<PublicUser>;
  replaceEmailLoginCode(code: EmailLoginCode): Promise<void>;
  consumeEmailLoginCode(email: string, codeHash: string, now: Date): Promise<boolean>;
  insertRefreshToken(token: StoredRefreshToken): Promise<void>;
  rotateRefreshToken(
    oldHash: string,
    next: StoredRefreshToken,
    now: Date,
  ): Promise<RotateResult>;
  revokeRefreshToken(hash: string, userId: string, now: Date): Promise<boolean>;
  revokeAllRefreshTokens(userId: string, now: Date): Promise<void>;
  getUser(id: string): Promise<PublicUser | null>;
  getProfile(userId: string): Promise<StoredProfile | null>;
  saveProfile(userId: string, profile: StoredProfile): Promise<void>;
  listProficiencies(userId: string): Promise<Proficiency[]>;
  replaceProficiencies(userId: string, items: Proficiency[], now: Date): Promise<void>;
  upsertProficiency(userId: string, item: Proficiency, now: Date): Promise<void>;
  addPaceSample(userId: string, sample: PaceSample): Promise<PaceSample>;
  listPaceSamples(userId: string, topic: string | null): Promise<PaceSample[]>;
  getCalendarConnection(userId: string): Promise<CalendarConnection>;
  setCalendarGrant(userId: string, refreshToken: string | null, connected: boolean): Promise<void>;
  createTask(userId: string, task: TaskRecord, now: Date): Promise<TaskRecord>;
  getActiveTask(userId: string): Promise<TaskRecord | null>;
  getTask(userId: string, id: string): Promise<TaskRecord | null>;
  saveTask(userId: string, task: TaskRecord): Promise<void>;
  insertSession(userId: string, session: SessionRecap): Promise<SessionRecap>;
  listSessions(userId: string): Promise<SessionRecap[]>;
  close(): Promise<void>;
};
