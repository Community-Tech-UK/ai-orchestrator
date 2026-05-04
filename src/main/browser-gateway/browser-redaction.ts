const REDACTED = '[REDACTED]';

const SENSITIVE_KEY_PARTS = [
  'authorization',
  'cookie',
  'set-cookie',
  'token',
  'password',
  'secret',
  'key',
  'session',
];

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    redacted[key] = isSensitiveKey(key) ? REDACTED : value;
  }
  return redacted;
}

export function redactBrowserText(value: string): string {
  let redacted = value;
  redacted = redacted.replace(
    /\b(authorization|proxy-authorization)\s*:\s*(?:Bearer|Basic|Digest)?\s*[A-Za-z0-9._~+/=-]+/gi,
    (_match, key: string) => `${key}: ${REDACTED}`,
  );
  redacted = redacted.replace(
    /\b(cookie|set-cookie)\s*:\s*[^\r\n]+/gi,
    (_match, key: string) => `${key}: ${REDACTED}`,
  );
  redacted = redacted.replace(
    /"([^"]*(?:authorization|cookie|set-cookie|token|password|secret|key|session)[^"]*)"\s*:\s*"[^"]*"/gi,
    (_match, key: string) => `"${key}": "${REDACTED}"`,
  );
  redacted = redacted.replace(
    /\b([A-Za-z0-9_-]*(?:authorization|cookie|set-cookie|token|password|secret|key|session)[A-Za-z0-9_-]*)\s*=\s*([^\s&]+)/gi,
    (_match, key: string) => `${key}=${REDACTED}`,
  );
  redacted = redacted.replace(
    /\b([A-Za-z0-9_-]*(?:authorization|cookie|set-cookie|token|password|secret|key|session)[A-Za-z0-9_-]*)\s*:\s*([^\s]+)/gi,
    (_match, key: string) => `${key}: ${REDACTED}`,
  );
  return redacted;
}
