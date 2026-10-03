import { HttpError } from "../http.ts";

const TOKEN_URL = "https://generativelanguage.googleapis.com/v1alpha/auth_tokens";
const TOKEN_TTL_MS = 30 * 60 * 1000;
const FAILED = "Gemini could not issue a token.";

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type MintedEphemeralToken = {
  token: string;
  expireTime: string;
};

function failed(): HttpError {
  return new HttpError(502, "gemini_token_failed", FAILED);
}

function readToken(payload: unknown, fallbackExpireTime: string): MintedEphemeralToken {
  if (!payload || typeof payload !== "object") throw failed();
  const record = payload as { name?: unknown; token?: unknown; expireTime?: unknown };
  const token =
    typeof record.name === "string" && record.name.length > 0
      ? record.name
      : typeof record.token === "string" && record.token.length > 0
        ? record.token
        : null;
  if (!token) throw failed();
  const expireTime =
    typeof record.expireTime === "string" && record.expireTime.length > 0
      ? record.expireTime
      : fallbackExpireTime;
  return { token, expireTime };
}

export async function mintEphemeralToken(input: {
  apiKey: string;
  now: Date;
  fetchImpl: FetchLike;
}): Promise<MintedEphemeralToken> {
  const expireTime = new Date(input.now.getTime() + TOKEN_TTL_MS).toISOString();
  const url = `${TOKEN_URL}?key=${encodeURIComponent(input.apiKey)}`;
  let response: Response;
  try {
    response = await input.fetchImpl(url, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uses: 1, expireTime }),
    });
  } catch {
    throw failed();
  }

  if (!response.ok) {
    await response.text().catch(() => undefined);
    throw failed();
  }

  try {
    return readToken(await response.json(), expireTime);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw failed();
  }
}
