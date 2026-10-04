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
  SessionNote,
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

export type AdminUserRow = {
  id: string;
  email: string | null;
  name: string | null;
  created_at: string | null;
  last_login_at: string | null;
  calendar_connected?: boolean;
};

export type AdminOverview = {
  storage: "file" | "postgres";
  userCount: number;
  sessionCount: number;
  taskCount: number;
  paceCount: number;
  proficiencyCount: number;
  profileCount: number;
  emailCodeCount: number;
  activeRefreshTokens: number;
  users: AdminUserRow[];
};

export type AdminUserDetail = {
  user: {
    id: string;
    email: string | null;
    email_verified: boolean;
    name: string | null;
    picture: string | null;
    google_sub: string | null;
    created_at: string | null;
    last_login_at: string | null;
    calendar_connected: boolean;
    has_google_refresh_token: boolean;
  };
  profile: import("../product/model.ts").StoredProfile | null;
  proficiencies: import("../product/model.ts").Proficiency[];
  pace: import("../product/model.ts").PaceSample[];
  tasks: import("../product/model.ts").TaskRecord[];
  sessions: import("../product/model.ts").SessionRecap[];
  tokens: { active: number; total: number; revoked: number };
};

export type AdminBrowseTable =
  | "users"
  | "tasks"
  | "sessions"
  | "session_notes"
  | "pace"
  | "proficiencies"
  | "profiles"
  | "email_codes"
  | "refresh_tokens";

export type AdminBrowseResult = {
  table: AdminBrowseTable;
  count: number;
  truncated: boolean;
  rows: Record<string, unknown>[];
};

export type ToolConnectionStatus = "connected" | "disconnected";

export type ToolConnection = {
  userId: string;
  toolId: string;
  provider: string;
  scopes: string;
  refreshToken: string | null;
  status: ToolConnectionStatus;
  connectedAt: string | null;
  updatedAt: string;
};

export type ToolConnectionWrite = Omit<ToolConnection, "userId">;

export type Store = {
  kind: "file" | "postgres";
  adminOverview(): Promise<AdminOverview>;
  adminUserDetail(userId: string): Promise<AdminUserDetail | null>;
  adminBrowse(table: AdminBrowseTable, limit?: number): Promise<AdminBrowseResult>;
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
  listToolConnections(userId: string): Promise<ToolConnection[]>;
  upsertToolConnection(userId: string, connection: ToolConnectionWrite): Promise<void>;
  /** Clears that row's refresh token and sets status `disconnected`. Keeps the row. */
  disconnectTool(userId: string, toolId: string): Promise<void>;
  createTask(userId: string, task: TaskRecord, now: Date): Promise<TaskRecord>;
  getActiveTask(userId: string): Promise<TaskRecord | null>;
  getTask(userId: string, id: string): Promise<TaskRecord | null>;
  saveTask(userId: string, task: TaskRecord): Promise<void>;
  insertSession(userId: string, session: SessionRecap): Promise<SessionRecap>;
  listSessions(userId: string): Promise<SessionRecap[]>;
  /** Insert or replace the note for (userId, session_id). `created` is false on replace. */
  upsertSessionNote(
    userId: string,
    note: SessionNote,
  ): Promise<{ note: SessionNote; created: boolean }>;
  listSessionNotes(userId: string, limit: number): Promise<SessionNote[]>;
  getSessionNote(userId: string, id: string): Promise<SessionNote | null>;
  /** Permanently delete the user account and all synced data (admin row gone). */
  clearUserData(userId: string, now: Date): Promise<void>;
  close(): Promise<void>;
};
