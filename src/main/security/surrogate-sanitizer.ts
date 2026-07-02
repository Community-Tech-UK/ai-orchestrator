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
  return sanitizeValue(value, new WeakMap()) as T;
}

/**
 * Recursive worker with a seen-map so shared references stay shared and
 * circular structures cannot recurse forever (each visited container maps to
 * its sanitized copy before children are walked).
 */
function sanitizeValue(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === 'string') {
    return stripLoneSurrogates(value);
  }

  if (Array.isArray(value)) {
    const existing = seen.get(value);
    if (existing !== undefined) return existing;
    const sanitized: unknown[] = [];
    seen.set(value, sanitized);
    for (const item of value) {
      sanitized.push(sanitizeValue(item, seen));
    }
    return sanitized;
  }

  if (value !== null && typeof value === 'object' && isPlainObject(value)) {
    const existing = seen.get(value);
    if (existing !== undefined) return existing;
    const sanitized: Record<string, unknown> = {};
    seen.set(value, sanitized);
    for (const [key, entry] of Object.entries(value)) {
      sanitized[key] = sanitizeValue(entry, seen);
    }
    return sanitized;
  }

  return value;
}
