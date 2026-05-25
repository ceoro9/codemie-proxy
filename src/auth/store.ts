import fs from 'fs';
import { config } from '../config';
import type { AuthCache } from '../types';

export function loadCache(): AuthCache {
  try {
    if (fs.existsSync(config.authCachePath)) {
      return JSON.parse(fs.readFileSync(config.authCachePath, 'utf-8')) as AuthCache;
    }
  } catch { /* ignore */ }
  return {};
}

export function saveCache(data: AuthCache): void {
  fs.writeFileSync(config.authCachePath, JSON.stringify(data, null, 2), { mode: 0o600 });
}
