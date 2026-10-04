import { codeChallenge } from "./tokens.ts";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

export type GoogleUserInfo = {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
};

export type GoogleClient = {
  exchangeCode(input: {
    code: string;
    codeVerifier: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  }): Promise<{ accessToken: string; refreshToken: string | null }>;
  fetchUserInfo(accessToken: string): Promise<GoogleUserInfo>;
};

export class GoogleExchangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleExchangeError";
  }
}

export function authorizationUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeVerifier: string;
  scopes?: string;
  /** Default false so a previous tool grant is not folded into this token. */
  includeGrantedScopes?: boolean;
}): string {
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", input.scopes ?? "openid email profile");
  url.searchParams.set("include_granted_scopes", input.includeGrantedScopes === true ? "true" : "false");
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", codeChallenge(input.codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

export function createGoogleClient(fetchImpl: typeof fetch = fetch): GoogleClient {
  return {
    async exchangeCode(input) {
      const body = new URLSearchParams({
        code: input.code,
        client_id: input.clientId,
        client_secret: input.clientSecret,
        redirect_uri: input.redirectUri,
        grant_type: "authorization_code",
        code_verifier: input.codeVerifier,
      });
      const response = await fetchImpl(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      const payload = (await response.json().catch(() => null)) as {
        access_token?: string;
        refresh_token?: string;
        error_description?: string;
        error?: string;
      } | null;
      if (!response.ok || !payload?.access_token) {
        const detail = payload?.error_description || payload?.error || `HTTP ${response.status}`;
        throw new GoogleExchangeError(`Google token exchange failed: ${detail}`);
      }
      return {
        accessToken: payload.access_token,
        refreshToken: payload.refresh_token ?? null,
      };
    },
    async fetchUserInfo(accessToken) {
      const response = await fetchImpl(USERINFO_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const payload = (await response.json().catch(() => null)) as {
        sub?: string;
        email?: string;
        email_verified?: boolean;
        name?: string;
        picture?: string;
        error_description?: string;
      } | null;
      if (!response.ok || !payload?.sub) {
        const detail = payload?.error_description || `HTTP ${response.status}`;
        throw new GoogleExchangeError(`Google user info failed: ${detail}`);
      }
      return {
        sub: payload.sub,
        email: payload.email ?? null,
        emailVerified: payload.email_verified === true,
        name: payload.name ?? null,
        picture: payload.picture ?? null,
      };
    },
  };
}
