export interface SSOStore {
  cookies: Record<string, string>;
  expiresAt: number;
}

export interface TokenStore {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export interface AuthCache {
  sso?: SSOStore;
  token?: TokenStore;
}
