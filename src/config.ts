import path from 'path';
import os from 'os';

export type AuthType = 'sso' | 'password' | 'client';

export interface ModelEntry {
  id: string;
  slug: string;
}

const authType = (process.env.CODEMIE_AUTH_TYPE ?? 'sso') as AuthType;
if (!['sso', 'password', 'client'].includes(authType)) {
  console.error(`Invalid CODEMIE_AUTH_TYPE "${authType}". Must be sso | password | client.`);
  process.exit(1);
}

const assistantSlug = process.env.CODEMIE_ASSISTANT_SLUG ?? '';
if (!assistantSlug) {
  console.error('CODEMIE_ASSISTANT_SLUG is required.');
  process.exit(1);
}

if (authType === 'password' && (!process.env.CODEMIE_USERNAME || !process.env.CODEMIE_PASSWORD)) {
  console.error('CODEMIE_USERNAME and CODEMIE_PASSWORD are required when CODEMIE_AUTH_TYPE=password.');
  process.exit(1);
}
if (authType === 'client' && !process.env.CODEMIE_CLIENT_SECRET) {
  console.error('CODEMIE_CLIENT_SECRET is required when CODEMIE_AUTH_TYPE=client.');
  process.exit(1);
}

// CODEMIE_MODELS: comma-separated "modelId" or "modelId:slug" entries.
// Slug defaults to CODEMIE_ASSISTANT_SLUG when omitted.
// Example: "claude-opus-4-7,claude-sonnet-4-6:my-sonnet-slug"
function parseModels(raw: string | undefined, defaultSlug: string): ModelEntry[] {
  if (!raw?.trim()) return [{ id: defaultSlug, slug: defaultSlug }];
  return raw.split(',').map((entry) => {
    const [id, slug] = entry.trim().split(':');
    return { id: id.trim(), slug: (slug ?? defaultSlug).trim() };
  });
}

export const config = {
  authType,
  serverUrl: (process.env.CODEMIE_SERVER_URL ?? 'https://codemie.lab.epam.com/code-assistant-api').replace(/\/$/, ''),
  assistantSlug,
  keycloakUrl: (process.env.CODEMIE_KEYCLOAK_URL ?? 'https://keycloak.eks-core.aws.main.edp.projects.epam.com/auth').replace(/\/$/, ''),
  realm: process.env.CODEMIE_REALM ?? 'codemie-prod',
  clientId: process.env.CODEMIE_CLIENT_ID ?? 'codemie-sdk',
  clientSecret: process.env.CODEMIE_CLIENT_SECRET ?? '',
  username: process.env.CODEMIE_USERNAME ?? '',
  password: process.env.CODEMIE_PASSWORD ?? '',
  port: Number(process.env.PORT ?? 9090),
  // When set, the SSO callback server binds to this fixed port instead of a random one.
  // Required for Docker: publish this port with -p <port>:<port> so the browser redirect reaches the container.
  ssoCallbackPort: Number(process.env.CODEMIE_SSO_CALLBACK_PORT ?? 0),
  authCachePath: process.env.CODEMIE_AUTH_CACHE ?? path.join(os.homedir(), '.codemie-proxy-auth.json'),
  requestTimeout: Number(process.env.CODEMIE_REQUEST_TIMEOUT ?? 120_000),
  streamIdleTimeout: Number(process.env.CODEMIE_STREAM_IDLE_TIMEOUT ?? 60_000),
  models: parseModels(process.env.CODEMIE_MODELS, assistantSlug),
} as const;
