const REDACTED = '[redacted]';
const SENSITIVE_KEY_PATTERN = /password|secret|token|key|credential|clipboard|text|data|image/i;
const MAX_STRING_LENGTH = 500;

export function redactDesktopMetadata(value: unknown): Record<string, unknown> {
  const redacted = redactValue(value);
  return redacted && typeof redacted === 'object' && !Array.isArray(redacted)
    ? redacted as Record<string, unknown>
    : { value: redacted };
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.slice(0, 50).map(redactValue);
  }
  if (!value || typeof value !== 'object') {
    return redactScalar(value);
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? REDACTED
      : redactValue(child);
  }
  return output;
}

function redactScalar(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  if (value.length > MAX_STRING_LENGTH) {
    return `${value.slice(0, MAX_STRING_LENGTH)}...[truncated]`;
  }
  return value;
}
