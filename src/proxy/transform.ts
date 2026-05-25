// ─── Shared ────────────────────────────────────────────────────────────────

interface CodeMieThought {
  author_name?: string;
  author_type?: string;
  message?: string;
  input_text?: string;
  in_progress?: boolean;
}

interface CodeMieChunk {
  generated_chunk?: string | null;
  generated?: string | null;
  tokensUsed?: number;
  taskId?: string;
  thought?: CodeMieThought;
}

/**
 * Extracts the incremental text delta from a streamed CodeMie chunk.
 * CodeMie streams text via thought.message (author "Codemie Thoughts");
 * generated_chunk is always null and should be ignored.
 */
export function toDelta(obj: unknown): string {
  const chunk = obj as CodeMieChunk;
  if (chunk.thought?.author_name === 'Codemie Thoughts' && chunk.thought.message) {
    return chunk.thought.message;
  }
  return chunk.generated_chunk ?? '';
}

// ─── OpenAI format (/v1/chat/completions) ──────────────────────────────────

interface OpenAICompletion {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export function toCompletion(data: unknown, model: string): OpenAICompletion {
  const d = data as CodeMieChunk;
  return {
    id: d.taskId ?? `codemie-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: d.generated ?? '' },
      finish_reason: 'stop',
    }],
    usage: {
      prompt_tokens: 0,
      completion_tokens: d.tokensUsed ?? 0,
      total_tokens: d.tokensUsed ?? 0,
    },
  };
}

function sseChunk(id: string, model: string, created: number, choices: unknown[], usage?: unknown): string {
  const obj: Record<string, unknown> = { id, object: 'chat.completion.chunk', created, model, choices };
  if (usage !== undefined) obj.usage = usage;
  return `data: ${JSON.stringify(obj)}\n\n`;
}

// First chunk: announces the assistant role (required by LiteLLM and strict OpenAI clients).
export function toSSERoleLine(id: string, model: string, created: number): string {
  return sseChunk(id, model, created, [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]);
}

export function toSSELine(content: string, id: string, model: string, created: number): string {
  return sseChunk(id, model, created, [{ index: 0, delta: { content }, finish_reason: null }]);
}

export function toSSEStopLine(id: string, model: string, created: number, outputTokens: number): string {
  return sseChunk(
    id, model, created,
    [{ index: 0, delta: {}, finish_reason: 'stop' }],
    { prompt_tokens: 0, completion_tokens: outputTokens, total_tokens: outputTokens },
  );
}

// ─── Anthropic format (/v1/messages) ───────────────────────────────────────

type AnthropicContentBlock = { type: string; text?: string };

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

function extractAnthropicContent(content: string | AnthropicContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
}

/**
 * Formats the full Anthropic messages array (+ optional system prompt) into a
 * single CodeMie `text` field, preserving conversation context.
 */
export function buildCodeMieText(messages: AnthropicMessage[], system?: string): string {
  const parts: string[] = [];
  if (system) parts.push(`<system>\n${system}\n</system>`);
  for (const msg of messages) {
    const role = msg.role === 'user' ? 'Human' : 'Assistant';
    parts.push(`${role}: ${extractAnthropicContent(msg.content)}`);
  }
  return parts.join('\n\n');
}

export function toAnthropicCompletion(data: unknown, model: string, msgId: string): object {
  const d = data as CodeMieChunk;
  return {
    id: msgId,
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: d.generated ?? '' }],
    model,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: d.tokensUsed ?? 0 },
  };
}

function anthropicSSEEvent(event: string, data: object): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function anthropicStreamStart(msgId: string, model: string): string {
  return (
    anthropicSSEEvent('message_start', {
      type: 'message_start',
      message: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 1 },
      },
    }) +
    anthropicSSEEvent('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }) +
    anthropicSSEEvent('ping', { type: 'ping' })
  );
}

export function anthropicStreamDelta(text: string): string {
  return anthropicSSEEvent('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  });
}

export function anthropicStreamEnd(outputTokens: number): string {
  return (
    anthropicSSEEvent('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    anthropicSSEEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: outputTokens },
    }) +
    anthropicSSEEvent('message_stop', { type: 'message_stop' })
  );
}
