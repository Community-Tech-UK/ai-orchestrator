import type { BrowserElementContext } from '@contracts/types/browser';

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

const SENSITIVE_ATTRIBUTE_NAMES = new Set([
  'value',
  'data-value',
]);

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    SENSITIVE_ATTRIBUTE_NAMES.has(normalized) ||
    SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part))
  );
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

export function redactBrowserUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.username) {
      parsed.username = REDACTED;
    }
    if (parsed.password) {
      parsed.password = REDACTED;
    }
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (isSensitiveKey(key)) {
        parsed.searchParams.set(key, REDACTED);
      }
    }
    if (parsed.hash) {
      parsed.hash = REDACTED;
    }
    return parsed.toString();
  } catch {
    return redactBrowserText(value);
  }
}

export function redactElementContext(
  context: BrowserElementContext,
): BrowserElementContext {
  const redacted: BrowserElementContext = {};
  for (const [key, value] of Object.entries(context)) {
    if (value === undefined) {
      continue;
    }
    if (key === 'attributes' && isStringRecord(value)) {
      redacted.attributes = {};
      for (const [attribute, attributeValue] of Object.entries(value)) {
        redacted.attributes[attribute] = isSensitiveKey(attribute)
          ? REDACTED
          : redactBrowserText(attributeValue).slice(0, 1_000);
      }
      continue;
    }
    if (typeof value === 'string') {
      (redacted as Record<string, string>)[key] =
        key === 'formAction' ? redactBrowserUrl(value) : redactBrowserText(value);
    }
  }
  return redacted;
}

export function redactBrowserNetworkRequests(entries: unknown[]): unknown[] {
  return entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return entry;
    }
    const record = entry as Record<string, unknown>;
    return {
      ...record,
      ...(typeof record['url'] === 'string'
        ? { url: redactBrowserUrl(record['url']) }
        : {}),
      ...(isStringRecord(record['headers'])
        ? { headers: redactHeaders(record['headers']) }
        : {}),
    };
  });
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.values(value).every((item) => typeof item === 'string'),
  );
}
