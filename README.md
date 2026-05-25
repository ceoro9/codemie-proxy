# codemie-proxy

A lightweight HTTP proxy that makes [CodeMie](https://codemie.ai) (EPAM's AI assistant) accessible to any **OpenAI-compatible or Anthropic-compatible client** — such as LiteLLM, Continue.dev, or Claude Code — without any changes to those clients.

## Features

- **OpenAI** `/v1/chat/completions` — streaming and non-streaming
- **Anthropic** `/v1/messages` — full SSE event sequence (Claude Code / claude CLI)
- **`/v1/models`** — model discovery for LiteLLM and other clients
- **Multi-model routing** — map multiple model IDs to different CodeMie assistant slugs
- **Three auth modes** — SSO (browser), password (Keycloak ROPC), client credentials
- **Resilient streaming** — handles idle timeouts, premature closes, and upstream 401 retries

## Requirements

- Node.js 18 or later
- A CodeMie account with at least one assistant slug

## Quick start

```bash
git clone <this-repo>
cd codemie-proxy

cp .env.example .env
# edit .env — set CODEMIE_ASSISTANT_SLUG at minimum

npm install       # installs deps and builds dist/
npm start         # http://localhost:9090
```

For development with hot-reload:

```bash
npm run dev
```

## Auth modes

| Mode | `CODEMIE_AUTH_TYPE` | How it works |
|---|---|---|
| SSO | `sso` (default) | Opens a browser on first request; EPAM SSO redirect delivers session cookies |
| Password | `password` | Keycloak ROPC grant; tokens auto-refresh before expiry |
| Client credentials | `client` | Keycloak `client_credentials`; suitable for CI and service accounts |

Auth state is cached in `~/.codemie-proxy-auth.json` (mode 0600, never committed).

```bash
# Force re-login
curl -X POST http://localhost:9090/auth/reset
```

## Configuration

Copy `.env.example` to `.env` and fill in the values.

| Variable | Default | Required |
|---|---|---|
| `CODEMIE_ASSISTANT_SLUG` | — | **yes** |
| `CODEMIE_AUTH_TYPE` | `sso` | no |
| `CODEMIE_MODELS` | _(slug as single model)_ | no |
| `CODEMIE_SERVER_URL` | `https://codemie.lab.epam.com/code-assistant-api` | no |
| `CODEMIE_KEYCLOAK_URL` | EPAM prod Keycloak | no |
| `CODEMIE_REALM` | `codemie-prod` | no |
| `CODEMIE_CLIENT_ID` | `codemie-sdk` | no |
| `CODEMIE_CLIENT_SECRET` | — | `client` mode |
| `CODEMIE_USERNAME` | — | `password` mode |
| `CODEMIE_PASSWORD` | — | `password` mode |
| `PORT` | `9090` | no |
| `CODEMIE_SSO_CALLBACK_PORT` | random | no (required for Docker SSO) |
| `CODEMIE_REQUEST_TIMEOUT` | `120000` (ms) | no |
| `CODEMIE_STREAM_IDLE_TIMEOUT` | `60000` (ms) | no |

### Multi-model setup

`CODEMIE_MODELS` is a comma-separated list of model IDs, each optionally mapped to a specific assistant slug:

```bash
# All models share the default CODEMIE_ASSISTANT_SLUG
CODEMIE_MODELS=claude-opus-4-7,claude-sonnet-4-6,claude-haiku-4-5

# Each model gets its own assistant (overrides CODEMIE_ASSISTANT_SLUG per model)
CODEMIE_MODELS=claude-opus-4-7:opus-slug,claude-sonnet-4-6:sonnet-slug
```

If `CODEMIE_MODELS` is not set, a single model entry is created using `CODEMIE_ASSISTANT_SLUG` as both the model ID and slug.

## LiteLLM integration

```yaml
# litellm-config.yaml
model_list:
  - model_name: claude-opus-4-7
    litellm_params:
      model: openai/claude-opus-4-7
      api_base: http://localhost:9090
      api_key: dummy

litellm_settings:
  drop_params: true
```

```bash
litellm --config litellm-config.yaml
# or via Docker:
docker run -p 4000:4000 \
  -v ./litellm-config.yaml:/app/config.yaml \
  ghcr.io/berriai/litellm:main-latest \
  --config /app/config.yaml
```

For multi-model setups, add one `model_list` entry per model that matches your `CODEMIE_MODELS` list.

## Claude Code (claude CLI) integration

Claude Code uses the Anthropic API protocol. Point it at the proxy:

```bash
# In your shell profile or Claude Code settings:
export ANTHROPIC_BASE_URL=http://localhost:9090
export ANTHROPIC_API_KEY=dummy   # required by the client, not used by the proxy
```

Or via Claude Code's model configuration:

```json
{
  "model": "claude-opus-4-7",
  "apiBaseUrl": "http://localhost:9090"
}
```

## Docker

```bash
docker build -t codemie-proxy .
```

**SSO mode (default)** — works in Docker by publishing a fixed callback port:

```bash
docker run -p 9090:9090 -p 9091:9091 \
  -e CODEMIE_ASSISTANT_SLUG=your-slug \
  -e CODEMIE_SSO_CALLBACK_PORT=9091 \
  codemie-proxy
```

The proxy starts a callback server on port 9091 inside the container. After EPAM SSO login, CodeMie redirects the browser to `localhost:9091?token=…` — Docker forwards it back into the container, completing the auth.

**Password mode** (no browser needed):

```bash
docker run -p 9090:9090 \
  -e CODEMIE_ASSISTANT_SLUG=your-slug \
  -e CODEMIE_AUTH_TYPE=password \
  -e CODEMIE_USERNAME=you@epam.com \
  -e CODEMIE_PASSWORD=secret \
  codemie-proxy
```

**Persist the auth cache** across container restarts (SSO and password modes):

```bash
docker run -p 9090:9090 -p 9091:9091 \
  -e CODEMIE_ASSISTANT_SLUG=your-slug \
  -e CODEMIE_SSO_CALLBACK_PORT=9091 \
  -v "$HOME/.codemie-proxy-auth.json:/home/proxy/.codemie-proxy-auth.json" \
  codemie-proxy
```

## Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat, streaming supported |
| `POST` | `/v1/messages` | Anthropic Messages API, full SSE sequence |
| `POST` | `/v1/messages/count_tokens` | Stub (returns `{ input_tokens: 0 }`) |
| `GET` | `/v1/models` | Lists configured models in OpenAI format |
| `GET` | `/auth/login` | Trigger auth and return status |
| `POST` | `/auth/reset` | Clear cached auth; forces re-login on next request |
| `GET` | `/health` | Returns server status, auth type, and endpoint list |

## Development

```bash
npm run dev         # start with hot-reload (tsx)
npm run typecheck   # type-check without emitting
npm run build       # compile src/ → dist/
npm run clean       # remove dist/
```

## Project structure

```
src/
├── config.ts         # Env-var config and startup validation
├── index.ts          # Express app entry point
├── logger.ts         # ISO-timestamp logger
├── types.ts          # Shared interfaces
├── auth/
│   ├── index.ts      # getAuthHeaders() dispatcher + in-flight dedup
│   ├── keycloak.ts   # Token fetch/refresh (password + client modes)
│   ├── sso.ts        # Browser-redirect SSO flow
│   └── store.ts      # File-based auth cache (~/.codemie-proxy-auth.json)
└── proxy/
    ├── ndjson.ts     # CodeMie NDJSON/SSE stream parser
    ├── routes.ts     # Express route handlers
    └── transform.ts  # CodeMie ↔ OpenAI ↔ Anthropic format translation
```
