/**
 * Parses a streaming response from CodeMie.
 * Handles both raw NDJSON and SSE-formatted streams (data: {...}).
 * Multiple JSON objects may arrive per chunk, separated by newlines or `}{`.
 * Returns parsed objects and any incomplete trailing bytes for the next call.
 */
export function parseObjects(buffer: string, chunk: Buffer): [unknown[], string] {
  // Normalise `}{` → `}\n{` so we can reliably split on newlines
  const text = (buffer + chunk.toString()).replace(/\}\s*\{/g, '}\n{');
  const lines = text.split('\n');
  const remainder = lines.pop() ?? '';
  const objects: unknown[] = [];

  for (const line of lines) {
    const parsed = tryParseLine(line);
    if (parsed !== null) objects.push(parsed);
  }

  return [objects, remainder];
}

/** Parses a single line, stripping SSE prefix if present. Returns null on failure. */
export function tryParseLine(line: string): unknown | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // Strip SSE field prefix: "data: ", "event: ", "id: ", "retry: "
  const jsonStr = trimmed.startsWith('data: ') ? trimmed.slice(6).trim() : trimmed;

  // SSE stream-end sentinel
  if (!jsonStr || jsonStr === '[DONE]') return null;

  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}
