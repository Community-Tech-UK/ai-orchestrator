/**
 * Provider-bound UTF-16 cleanup.
 *
 * This intentionally only strips invalid lone surrogate code units. It does
 * not normalize text or remove invisible characters; prompt-injection Unicode
 * defense lives in unicode-sanitizer.ts and has different semantics.
 */

function isHighSurrogate(code: number): boolean {
  return code >= 0xD800 && code <= 0xDBFF;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xDC00 && code <= 0xDFFF;
}

export function stripLoneSurrogates(input: string): string {
  let output = '';

  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (isHighSurrogate(code)) {
      const nextCode = index + 1 < input.length ? input.charCodeAt(index + 1) : 0;
      if (isLowSurrogate(nextCode)) {
        output += input[index] + input[index + 1];
        index += 1;
      }
      continue;
    }

    if (isLowSurrogate(code)) {
      continue;
    }

    output += input[index];
  }

  return output;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function sanitizeProviderText<T>(value: T): T {
  if (typeof value === 'string') {
    return stripLoneSurrogates(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeProviderText(item)) as T;
  }

  if (value !== null && typeof value === 'object' && isPlainObject(value)) {
    const sanitized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      sanitized[key] = sanitizeProviderText(entry);
    }
    return sanitized as T;
  }

  return value;
}
