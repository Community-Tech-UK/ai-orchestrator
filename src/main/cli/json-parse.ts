import { jsonrepair } from 'jsonrepair';
import { Allow, parse as parsePartialJson } from 'partial-json';

const FAILURE_EXCERPT_CHARS = 200;

export interface JsonParseResult<T = unknown> {
  readonly ok: true;
  readonly value: T;
  readonly repaired: boolean;
  readonly partial: boolean;
}

export interface JsonParseFailure {
  readonly ok: false;
  readonly error: string;
  readonly inputExcerpt: string;
}

export function parseJsonWithRepair<T = unknown>(input: string): JsonParseResult<T> | JsonParseFailure {
  const trimmed = input.trim();
  try {
    return success(JSON.parse(trimmed) as T, false, false);
  } catch (parseError) {
    if (looksStructurallyIncomplete(trimmed)) {
      return failure(trimmed, parseError);
    }
    try {
      const repaired = jsonrepair(trimmed);
      const parsed = JSON.parse(repaired) as T;
      if (isBareTextStringRepair(trimmed, parsed)) {
        return failure(trimmed, parseError);
      }
      return success(parsed, true, false);
    } catch (repairError) {
      return failure(trimmed, repairError, parseError);
    }
  }
}

export function parseStreamingJson<T = unknown>(input: string): JsonParseResult<T> | JsonParseFailure {
  const trimmed = input.trim();
  try {
    return success(JSON.parse(trimmed) as T, false, false);
  } catch (parseError) {
    try {
      return success(parsePartialJson(trimmed, Allow.ALL) as T, false, true);
    } catch (partialError) {
      try {
        const repaired = jsonrepair(trimmed);
        const parsed = JSON.parse(repaired) as T;
        if (isBareTextStringRepair(trimmed, parsed)) {
          return failure(trimmed, partialError, parseError);
        }
        return success(parsed, true, false);
      } catch (repairError) {
        return failure(trimmed, repairError, partialError, parseError);
      }
    }
  }
}

export function parseNdjsonLine<T = unknown>(line: string): JsonParseResult<T> | JsonParseFailure {
  return parseJsonWithRepair<T>(line);
}

function success<T>(value: T, repaired: boolean, partial: boolean): JsonParseResult<T> {
  return {
    ok: true,
    value,
    repaired,
    partial,
  };
}

function failure(input: string, ...errors: unknown[]): JsonParseFailure {
  return {
    ok: false,
    error: firstErrorMessage(errors),
    inputExcerpt: input.slice(0, FAILURE_EXCERPT_CHARS),
  };
}

function firstErrorMessage(errors: readonly unknown[]): string {
  for (const error of errors) {
    if (error instanceof Error && error.message.trim()) {
      return error.message;
    }
    if (typeof error === 'string' && error.trim()) {
      return error;
    }
  }
  return 'Invalid JSON';
}

function isBareTextStringRepair(input: string, value: unknown): boolean {
  return typeof value === 'string' && !input.startsWith('"');
}

function looksStructurallyIncomplete(input: string): boolean {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (const char of input) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{' || char === '[') {
      stack.push(char);
    } else if (char === '}' || char === ']') {
      const expected = char === '}' ? '{' : '[';
      if (stack.pop() !== expected) {
        return false;
      }
    }
  }

  const last = input.trimEnd().at(-1);
  return inString || stack.length > 0 || last === ':' || last === ',';
}
