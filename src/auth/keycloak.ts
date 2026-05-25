import axios from 'axios';
import { config } from '../config';
import type { TokenStore } from '../types';

const TOKEN_URL = `${config.keycloakUrl}/realms/${config.realm}/protocol/openid-connect/token`;

function baseParams(): Record<string, string> {
  const p: Record<string, string> = { client_id: config.clientId };
  if (config.clientSecret) p.client_secret = config.clientSecret;
  return p;
}

function parseJwtExpiry(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return typeof payload.exp === 'number' ? payload.exp * 1000 - 60_000 : null;
  } catch {
    return null;
  }
}

async function post(params: Record<string, string>): Promise<TokenStore> {
  const { data } = await axios.post<{
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  }>(TOKEN_URL, new URLSearchParams(params), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: parseJwtExpiry(data.access_token) ?? Date.now() + (data.expires_in - 60) * 1000,
  };
}

export function fetchToken(): Promise<TokenStore> {
  const params = {
    ...baseParams(),
    ...(config.authType === 'password'
      ? { grant_type: 'password', username: config.username, password: config.password }
      : { grant_type: 'client_credentials' }),
  };
  return post(params);
}

export function refreshToken(token: string): Promise<TokenStore> {
  return post({ ...baseParams(), grant_type: 'refresh_token', refresh_token: token });
}
