import { createHash } from 'node:crypto';

const C_STYLE_LANGUAGES = new Set([
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'java',
  'go',
  'rust',
]);

const PYTHON_STYLE_LANGUAGES = new Set(['python']);

export interface NormalizedHashes {
  contentHash: string;
  astNormalizedHash: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\n' || char === '\r' || char === '\t' || char === '\f';
}

function normalizeCStyle(source: string): string {
  let result = '';
  let i = 0;
  let inString: '"' | '\'' | '`' | null = null;

  while (i < source.length) {
    const char = source[i]!;
    const next = source[i + 1] ?? '';

    if (inString) {
      result += char;
      if (char === '\\' && i + 1 < source.length) {
        result += source[i + 1]!;
        i += 2;
        continue;
      }
      if (char === inString) {
        inString = null;
      }
      i += 1;
      continue;
    }

    if (char === '"' || char === '\'' || char === '`') {
      inString = char;
      result += char;
      i += 1;
      continue;
    }

    if (char === '/' && next === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n') {
        i += 1;
      }
      continue;
    }

    if (char === '/' && next === '*') {
      i += 2;
      while (i < source.length) {
        if (source[i] === '*' && source[i + 1] === '/') {
          i += 2;
          break;
        }
        i += 1;
      }
      continue;
    }

    if (!isWhitespace(char)) {
      result += char;
    }
    i += 1;
  }

  return result;
}

function normalizePython(source: string): string {
  let result = '';
  let i = 0;
  let inString: '"' | '\'' | null = null;
  let tripleQuoted = false;

  while (i < source.length) {
    const char = source[i]!;
    const next = source[i + 1] ?? '';
    const third = source[i + 2] ?? '';

    if (inString) {
      result += char;
      if (char === '\\' && i + 1 < source.length && !tripleQuoted) {
        result += source[i + 1]!;
        i += 2;
        continue;
      }
      if (tripleQuoted) {
        if (char === inString && next === inString && third === inString) {
          result += `${next}${third}`;
          i += 3;
          inString = null;
          tripleQuoted = false;
          continue;
        }
      } else if (char === inString) {
        inString = null;
      }
      i += 1;
      continue;
    }

    if ((char === '"' || char === '\'') && next === char && third === char) {
      inString = char;
      tripleQuoted = true;
      result += `${char}${next}${third}`;
      i += 3;
      continue;
    }

    if (char === '"' || char === '\'') {
      inString = char;
      tripleQuoted = false;
      result += char;
      i += 1;
      continue;
    }

    if (char === '#') {
      i += 1;
      while (i < source.length && source[i] !== '\n') {
        i += 1;
      }
      continue;
    }

    if (!isWhitespace(char)) {
      result += char;
    }
    i += 1;
  }

  return result;
}

export function normalizeAndHash(chunkText: string, language: string): NormalizedHashes {
  const contentHash = sha256(chunkText);
  const normalizedLanguage = language.toLowerCase();

  let normalized: string | null = null;
  if (C_STYLE_LANGUAGES.has(normalizedLanguage)) {
    normalized = normalizeCStyle(chunkText);
  } else if (PYTHON_STYLE_LANGUAGES.has(normalizedLanguage)) {
    normalized = normalizePython(chunkText);
  }

  if (normalized == null) {
    return { contentHash, astNormalizedHash: contentHash };
  }

  return {
    contentHash,
    astNormalizedHash: sha256(normalized),
  };
}
