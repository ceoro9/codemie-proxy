import { config } from '../config';
import { loadCache, saveCache } from './store';
import { ssoLogin } from './sso';
import { fetchToken, refreshToken } from './keycloak';
import { log } from '../logger';

const BASE_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };

let tokenRefreshInFlight: Promise<void> | null = null;
let ssoRefreshInFlight: Promise<void> | null = null;

function minsUntil(ms: number): string {
  return `${Math.round((ms - Date.now()) / 60_000)}m`;
}

export async function getAuthHeaders(forceRefresh = false): Promise<Record<string, string>> {
  if (config.authType === 'sso') {
    const cache = loadCache();

    if (forceRefresh || !cache.sso || Date.now() >= cache.sso.expiresAt) {
      if (ssoRefreshInFlight) {
        log.info('auth: waiting for in-flight SSO login');
        await ssoRefreshInFlight;
      } else {
        const reason = forceRefresh ? 'force refresh' : !cache.sso ? 'no cached session' : 'session expired';
        ssoRefreshInFlight = (async () => {
          log.info(`auth: SSO login required (${reason})`);
          const sso = await ssoLogin();
          saveCache({ ...loadCache(), sso });
          log.info(`auth: SSO login succeeded (expires in ${minsUntil(sso.expiresAt)})`);
        })().catch((err) => {
          log.error(`auth: SSO login failed: ${err instanceof Error ? err.message : String(err)}`);
          throw err;
        }).finally(() => { ssoRefreshInFlight = null; });
        await ssoRefreshInFlight;
      }
    } else {
      log.info(`auth: using cached SSO session (expires in ${minsUntil(cache.sso.expiresAt)})`);
    }

    const updated = loadCache();
    const cookie = Object.entries(updated.sso!.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    return { ...BASE_HEADERS, Cookie: cookie };
  }

  // password / client — Bearer token
  if (forceRefresh && !tokenRefreshInFlight) {
    log.info('auth: force refresh requested — evicting cached token');
    const cache = loadCache();
    saveCache({ ...cache, token: undefined });
  }

  const cache = loadCache();

  if (!cache.token || Date.now() >= cache.token.expiresAt) {
    if (ssoRefreshInFlight || tokenRefreshInFlight) {
      log.info('auth: waiting for in-flight token refresh');
    }
    if (!tokenRefreshInFlight) {
      const reason = !cache.token ? 'no cached token' : 'token expired';
      tokenRefreshInFlight = (async () => {
        const current = loadCache();
        log.info(`auth: refreshing token (${reason})`);
        let token;
        try {
          token = current.token?.refreshToken && config.authType === 'password'
            ? await refreshToken(current.token.refreshToken)
            : await fetchToken();
          log.info(`auth: token refreshed successfully (expires in ${minsUntil(token.expiresAt)})`);
        } catch (refreshErr) {
          log.warn(`auth: refresh_token failed (${refreshErr instanceof Error ? refreshErr.message : refreshErr}) — falling back to fetchToken`);
          token = await fetchToken();
          log.info(`auth: fetchToken succeeded (expires in ${minsUntil(token.expiresAt)})`);
        }
        saveCache({ ...loadCache(), token });
      })().catch((err) => {
        log.error(`auth: token fetch failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }).finally(() => { tokenRefreshInFlight = null; });
    }
    await tokenRefreshInFlight;
  } else {
    log.info(`auth: using cached token (expires in ${minsUntil(cache.token.expiresAt)})`);
  }

  const finalCache = loadCache();
  return { ...BASE_HEADERS, Authorization: `Bearer ${finalCache.token!.accessToken}` };
}

export function clearAuthCache(): void {
  const cache = loadCache();
  log.info('auth: cache cleared');
  if (config.authType === 'sso') {
    saveCache({ ...cache, sso: undefined });
  } else {
    saveCache({ ...cache, token: undefined });
  }
}
