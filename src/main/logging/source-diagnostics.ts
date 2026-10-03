import { createHash } from 'node:crypto';

/** Correlate source-bearing text without logging it; hashing work is bounded. */
export function textDiagnostic(text: string): { textChars: number; textHash: string } {
  return { textChars: text.length, textHash: createHash('sha256').update(text.slice(0, 8192)).digest('hex').slice(0, 16) };
}

/** Never forward Error stacks, causes, custom names/codes, or arbitrary metadata. */
export function errorDiagnostic(error: unknown): Record<string, unknown> {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return { errorKind: error instanceof Error ? 'Error' : typeof error, ...textDiagnostic(text) };
}
