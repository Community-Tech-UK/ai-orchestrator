/** Normalize whitespace for dedup comparison. */
function normalizeReasoningText(text: unknown): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Recursively extracts reasoning text from the heterogeneous `summary` field
 * that Codex sends on `reasoning` item completions.
 */
export function extractReasoningSections(value: unknown): string[] {
  if (!value) return [];

  if (typeof value === 'string') {
    const normalized = normalizeReasoningText(value);
    return normalized ? [normalized] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractReasoningSections(entry));
  }

  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    if (typeof obj['text'] === 'string') return extractReasoningSections(obj['text']);
    if ('summary' in obj) return extractReasoningSections(obj['summary']);
    if ('content' in obj) return extractReasoningSections(obj['content']);
    if ('parts' in obj) return extractReasoningSections(obj['parts']);
  }

  return [];
}

/** Merge new reasoning sections into existing, skipping duplicates. */
export function mergeReasoningSections(existing: string[], next: string[]): string[] {
  const merged: string[] = [];
  for (const section of [...existing, ...next]) {
    const normalized = normalizeReasoningText(section);
    if (!normalized || merged.includes(normalized)) continue;
    merged.push(normalized);
  }
  return merged;
}

/** Shorten a string to maxLen chars, appending ellipsis if truncated. */
export function shorten(text: string | undefined, maxLen: number): string {
  if (!text) return '';
  return text.length <= maxLen ? text : `${text.slice(0, maxLen - 1)}…`;
}
