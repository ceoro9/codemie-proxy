import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import axios, { AxiosResponse } from 'axios';
import { config } from '../config';
import { getAuthHeaders, clearAuthCache } from '../auth';
import { log } from '../logger';
import { parseObjects, tryParseLine } from './ndjson';
import {
  toDelta,
  toCompletion,
  toSSELine,
  toSSEStopLine,
  toSSERoleLine,
  buildCodeMieText,
  toAnthropicCompletion,
  anthropicStreamStart,
  anthropicStreamDelta,
  anthropicStreamEnd,
  type AnthropicMessage,
} from './transform';

export const router = Router();

// ─── Shared CodeMie call ────────────────────────────────────────────────────

function extractOpenAIText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as Array<{ text?: string }>).map((p) => p.text ?? '').join('');
  }
  return String(content ?? '');
}

function resolveSlug(model: string): string {
  return config.models.find((m) => m.id === model)?.slug ?? config.assistantSlug;
}

async function callCodeMie(
  text: string,
  stream: boolean,
  headers: Record<string, string>,
  model: string,
): Promise<AxiosResponse> {
  const slug = resolveSlug(model);
  const url = `${config.serverUrl}/v1/assistants/slug/${slug}/model`;
  return axios.post(
    url,
    { text, stream, conversation_id: crypto.randomUUID(), llmModel: model },
    { headers, responseType: stream ? 'stream' : 'json', timeout: config.requestTimeout },
  );
}

/** Pipes a CodeMie NDJSON stream to the response, using the provided formatters. */
function pipeStream(
  res: Response,
  upstream: AxiosResponse,
  reqId: string,
  onChunk: (obj: unknown) => string | null,
  onEnd: () => string,
): void {
  let buffer = '';
  let chunkCount = 0;
  let firstChunk = true;
  let finished = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  function finish(reason: string) {
    if (finished) return;
    finished = true;
    if (idleTimer) clearTimeout(idleTimer);
    if (buffer.trim()) {
      const obj = tryParseLine(buffer);
      if (obj !== null) {
        const line = onChunk(obj);
        if (line) res.write(line);
      } else {
        log.warn(`[${reqId}] unparseable final buffer: ${buffer.trim().slice(0, 120)}`);
      }
    }
    if (!res.writableEnded) {
      res.write(onEnd());
      res.end();
    }
    log.info(`[${reqId}] ${reason} — ${chunkCount} chunks`);
  }

  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => finish('stream idle timeout'), config.streamIdleTimeout);
  }

  resetIdleTimer();

  upstream.data.on('data', (chunk: Buffer) => {
    resetIdleTimer();
    if (firstChunk) {
      log.info(`[${reqId}] stream first chunk (${chunk.length}B): ${chunk.toString().slice(0, 120).replace(/\n/g, '\\n')}`);
      firstChunk = false;
    }
    const [objects, remaining] = parseObjects(buffer, chunk);
    buffer = remaining;
    for (const obj of objects) {
      const line = onChunk(obj);
      if (line) {
        res.write(line);
        chunkCount++;
      }
    }
  });

  upstream.data.on('end', () => finish('stream ended'));

  upstream.data.on('close', () => {
    if (!finished) {
      log.warn(`[${reqId}] stream closed without end`);
      finish('stream closed');
    }
  });

  upstream.data.on('error', (err: Error) => {
    log.error(`[${reqId}] upstream stream error: ${err.message}`);
    finish('stream error');
  });
}

function setSSEHeaders(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

async function resolveAuthHeaders(res: Response, reqId: string): Promise<Record<string, string> | null> {
  try {
    return await getAuthHeaders();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[${reqId}] auth failed: ${msg}`);
    res.status(401).json({ error: { message: `Auth failed: ${msg}` } });
    return null;
  }
}

/** Calls CodeMie and retries once with a force-refreshed token on upstream 401. */
async function callCodeMieWithRetry(
  text: string,
  stream: boolean,
  headers: Record<string, string>,
  model: string,
  reqId: string,
): Promise<AxiosResponse> {
  const t0 = Date.now();
  log.info(`[${reqId}] → CodeMie ${stream ? 'stream' : 'json'} model=${model} textLen=${text.length}`);
  try {
    const res = await callCodeMie(text, stream, headers, model);
    log.info(`[${reqId}] ← CodeMie ${res.status} in ${Date.now() - t0}ms`);
    return res;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 401) {
      log.warn(`[${reqId}] ← CodeMie 401 in ${Date.now() - t0}ms — forcing token refresh and retrying`);
      const freshHeaders = await getAuthHeaders(true);
      const t1 = Date.now();
      try {
        const retryRes = await callCodeMie(text, stream, freshHeaders, model);
        log.info(`[${reqId}] ← CodeMie ${retryRes.status} (retry) in ${Date.now() - t1}ms`);
        return retryRes;
      } catch (retryErr) {
        const status = axios.isAxiosError(retryErr) ? retryErr.response?.status : 'n/a';
        const body = axios.isAxiosError(retryErr) ? JSON.stringify(retryErr.response?.data) : String(retryErr);
        log.error(`[${reqId}] ← CodeMie ERROR ${status} (retry) in ${Date.now() - t1}ms: ${body}`);
        throw retryErr;
      }
    }
    const status = axios.isAxiosError(err) ? err.response?.status ?? 'n/a' : 'n/a';
    const body = axios.isAxiosError(err) ? JSON.stringify(err.response?.data ?? err.message) : String(err);
    log.error(`[${reqId}] ← CodeMie ERROR ${status} in ${Date.now() - t0}ms: ${body}`);
    throw err;
  }
}

// ─── OpenAI-compatible endpoint (LiteLLM, Continue, etc.) ──────────────────

router.post('/v1/chat/completions', async (req: Request, res: Response) => {
  const reqId = res.locals.reqId as string ?? 'unknown';
  const { messages = [], stream = false, model = 'codemie' } = req.body as {
    messages: Array<{ role: string; content: unknown }>;
    stream?: boolean;
    model?: string;
  };

  log.info(`[${reqId}] chat/completions model=${model} stream=${stream} msgs=${messages.length}`);

  const text = extractOpenAIText((messages[messages.length - 1] ?? {}).content);
  const headers = await resolveAuthHeaders(res, reqId);
  if (!headers) return;

  if (stream) {
    setSSEHeaders(res);
    let upstream: AxiosResponse;
    try {
      upstream = await callCodeMieWithRetry(text, true, headers, model, reqId);
    } catch (err) {
      const msg = axios.isAxiosError(err) ? (err.response?.data ?? err.message) : String(err);
      res.write(`data: ${JSON.stringify({ error: { message: msg } })}\n\n`);
      res.end();
      return;
    }
    const completionId = `chatcmpl-${crypto.randomUUID().replace(/-/g, '')}`;
    const created = Math.floor(Date.now() / 1000);
    res.write(toSSERoleLine(completionId, model, created));
    let outputTokens = 0;
    pipeStream(res, upstream, reqId,
      (obj) => {
        const c = toDelta(obj);
        if (!c) return null;
        outputTokens += c.length;
        return toSSELine(c, completionId, model, created);
      },
      () => toSSEStopLine(completionId, model, created, outputTokens) + 'data: [DONE]\n\n',
    );
  } else {
    try {
      const { data } = await callCodeMieWithRetry(text, false, headers, model, reqId);
      res.json(toCompletion(data, model));
    } catch (err) {
      if (axios.isAxiosError(err) && err.response) {
        res.status(err.response.status).json({ error: err.response.data });
      } else {
        res.status(500).json({ error: { message: String(err) } });
      }
    }
  }
});

// ─── Anthropic-compatible endpoint (Claude Code, claude CLI) ───────────────

router.post('/v1/messages', async (req: Request, res: Response) => {
  const reqId = res.locals.reqId as string ?? 'unknown';
  const { messages = [], system, stream = false, model = 'codemie' } = req.body as {
    messages: AnthropicMessage[];
    system?: string;
    stream?: boolean;
    model?: string;
    max_tokens?: number;
  };

  log.info(`[${reqId}] messages model=${model} stream=${stream} msgs=${messages.length} system=${!!system}`);

  const text = buildCodeMieText(messages, system);
  const msgId = `msg_${crypto.randomUUID().replace(/-/g, '')}`;
  const headers = await resolveAuthHeaders(res, reqId);
  if (!headers) return;

  if (stream) {
    setSSEHeaders(res);
    let upstream: AxiosResponse;
    try {
      upstream = await callCodeMieWithRetry(text, true, headers, model, reqId);
    } catch (err) {
      const msg = axios.isAxiosError(err) ? (err.response?.data ?? err.message) : String(err);
      res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: msg } })}\n\n`);
      res.end();
      return;
    }

    res.write(anthropicStreamStart(msgId, model));
    let outputTokens = 0;

    pipeStream(res, upstream, reqId,
      (obj) => {
        const c = toDelta(obj);
        if (!c) return null;
        outputTokens += c.length;
        return anthropicStreamDelta(c);
      },
      () => anthropicStreamEnd(outputTokens),
    );
  } else {
    try {
      const { data } = await callCodeMieWithRetry(text, false, headers, model, reqId);
      res.json(toAnthropicCompletion(data, model, msgId));
    } catch (err) {
      if (axios.isAxiosError(err) && err.response) {
        res.status(err.response.status).json({ error: err.response.data });
      } else {
        res.status(500).json({ error: { message: String(err) } });
      }
    }
  }
});

// Stub: Claude Code calls this before sending messages to estimate cost.
router.post('/v1/messages/count_tokens', (_req: Request, res: Response) => {
  res.json({ input_tokens: 0 });
});

// OpenAI-compatible model list — used by LiteLLM and other clients for model discovery.
router.get('/v1/models', (_req: Request, res: Response) => {
  const now = Math.floor(Date.now() / 1000);
  res.json({
    object: 'list',
    data: config.models.map((m) => ({
      id: m.id,
      object: 'model',
      created: now,
      owned_by: 'codemie',
    })),
  });
});

// ─── Auth & health ──────────────────────────────────────────────────────────

router.get('/auth/login', async (_req: Request, res: Response) => {
  try {
    await getAuthHeaders();
    res.json({ message: 'Authentication successful.', authType: config.authType });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(401).json({ error: { message: msg } });
  }
});

router.post('/auth/reset', (_req: Request, res: Response) => {
  clearAuthCache();
  res.json({ message: 'Auth cache cleared. Next request will re-authenticate.' });
});

router.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    authType: config.authType,
    serverUrl: config.serverUrl,
    assistantSlug: config.assistantSlug,
    endpoints: ['/v1/chat/completions', '/v1/messages'],
  });
});
