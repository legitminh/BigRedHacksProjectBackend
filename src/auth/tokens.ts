import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type AccessClaims = {
  sub: string;
  email: string | null;
  typ: "access";
  iat: number;
  exp: number;
};

export function newOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function hashesMatch(storedHash: string, providedHash: string): boolean {
  if (storedHash.length === 0 || storedHash.length !== providedHash.length) return false;
  return timingSafeEqual(Buffer.from(storedHash), Buffer.from(providedHash));
}

export function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function signAccessToken(
  secret: string,
  input: { sub: string; email: string | null },
  ttlSeconds: number,
  nowSeconds: number,
): string {
  const header = base64urlJson({ alg: "HS256", typ: "JWT" });
  const payload = base64urlJson({
    sub: input.sub,
    email: input.email,
    typ: "access",
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
  });
  const signingInput = `${header}.${payload}`;
  const signature = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

export function verifyAccessToken(
  secret: string,
  token: string,
  nowSeconds: number,
): AccessClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  if (!header || !payload || !signature) return null;
  const expected = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  const actualBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {
    return null;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!decoded || typeof decoded !== "object") return null;
  const claims = decoded as Partial<AccessClaims>;
  if (typeof claims.sub !== "string" || claims.sub.length === 0) return null;
  if (claims.typ !== "access") return null;
  if (typeof claims.exp !== "number" || claims.exp <= nowSeconds) return null;
  if (claims.email !== null && typeof claims.email !== "string") return null;
  return {
    sub: claims.sub,
    email: typeof claims.email === "string" ? claims.email : null,
    typ: "access",
    iat: typeof claims.iat === "number" ? claims.iat : nowSeconds,
    exp: claims.exp,
  };
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
