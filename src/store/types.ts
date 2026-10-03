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
  close(): Promise<void>;
};
