import { createHash } from 'node:crypto';

/** No raw protocol bodies, parser messages, arbitrary keys, or error names. */
const SAFE_TAGS: Record<string, ReadonlySet<string>> = {
  expected: new Set(['object', 'array']),
  missing: new Set(['sessionUpdate', 'toolCallId', 'title']),
  field: new Set(['entries', 'options']),
  sessionUpdate: new Set(['tool_call', 'tool_call_update', 'plan', 'config_option_update', 'session_info_update']),
  method: new Set(['session/request_permission', 'elicitation/create', 'session/update', 'elicitation/complete']),
};
const SAFE_ERROR_NAMES = new Set(['Error', 'SyntaxError', 'TypeError', 'RangeError', 'AbortError']);

/** Hash at most 8 Ki characters; input length still distinguishes larger data. */
export function acpTextDiagnostic(text: string): { textChars: number; textHash: string } {
  return { textChars: text.length, textHash: createHash('sha256').update(text.slice(0, 8192)).digest('hex').slice(0, 16) };
}

export function safeAcpProtocolDetails(details: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, values] of Object.entries(SAFE_TAGS)) {
    const value = details[key];
    if (typeof value === 'string' && values.has(value)) safe[key] = value;
  }
  for (const key of ['limitChars', 'lineChars']) {
    const value = details[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) safe[key] = value;
  }
  for (const key of ['id', 'sessionId', 'method', 'sessionUpdate', 'key']) {
    const value = details[key];
    if (typeof value === 'string' && !(key in safe)) {
      const diagnostic = acpTextDiagnostic(value);
      safe[`${key}Chars`] = diagnostic.textChars;
      safe[`${key}Hash`] = diagnostic.textHash;
    } else if (key === 'id' && typeof value === 'number' && Number.isFinite(value)) safe['id'] = value;
  }
  const line = details['line'];
  if (typeof line === 'string') {
    const diagnostic = acpTextDiagnostic(line);
    safe['lineChars'] = diagnostic.textChars;
    safe['lineHash'] = diagnostic.textHash;
  }
  if ('error' in details) {
    const error = details['error'];
    safe['errorKind'] = error instanceof Error && SAFE_ERROR_NAMES.has(error.name) ? error.name : 'unknown';
  }
  return safe;
}
