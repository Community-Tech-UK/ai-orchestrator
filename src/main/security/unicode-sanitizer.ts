/**
 * Unicode Sanitizer -- strips invisible/dangerous Unicode from text entering LLM context.
 *
 * Defends against prompt injection via:
 * - Zero-width spaces/joiners (U+200B-U+200F)
 * - Direction overrides (U+202A-U+202E, U+2066-U+2069)
 * - Tag characters (U+E0001-U+E007F) used for invisible instruction injection
 * - BOM (U+FEFF)
 * - Other format characters excluding safe whitespace
 *
 * Inspired by Claude Code utils/sanitization.ts (HackerOne #3086545).
 */

const MAX_ITERATIONS = 10;

/**
 * Regex matching dangerous invisible Unicode characters.
 * Covers: zero-width chars, direction controls, tag chars, BOM,
 * soft hyphen, word joiner, interlinear annotation anchors.
 *
 * Excludes safe whitespace: \t \n \r and normal space.
 */
const DANGEROUS_UNICODE_RE = new RegExp(
  [
    '[\u200B-\u200F]',           // zero-width space, ZWNJ, ZWJ, LRM, RLM
    '[\u2028-\u2029]',           // line/paragraph separator
    '[\u202A-\u202E]',           // direction embeddings and overrides
    '[\u2060-\u2064]',           // word joiner, invisible separators
    '[\u2066-\u2069]',           // isolate controls
    '[\u00AD]',                  // soft hyphen
    '[\uFEFF]',                  // BOM / ZWNBSP
    '[\uFFF9-\uFFFB]',          // interlinear annotation anchors
    '[\u{E0001}-\u{E007F}]',    // Tag characters
    '[\u{E0100}-\u{E01EF}]',    // Variation selectors supplement
  ].join('|'),
  'gu'
);

/**
 * Check whether a string contains dangerous invisible Unicode characters.
 */
export function containsDangerousUnicode(text: string): boolean {
  DANGEROUS_UNICODE_RE.lastIndex = 0;
  return DANGEROUS_UNICODE_RE.test(text);
}

/**
 * Strip dangerous invisible Unicode from text, then apply NFKC normalization.
 * Iterates up to MAX_ITERATIONS to handle cases where stripping reveals
 * new dangerous sequences.
 */
export function sanitizeUnicode(text: string): string {
  if (!text) return text;

  let result = text;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    DANGEROUS_UNICODE_RE.lastIndex = 0;
    const cleaned = result.replace(DANGEROUS_UNICODE_RE, '');
    const normalized = cleaned.normalize('NFKC');
    if (normalized === result) break;
    result = normalized;
  }
  return result;
}

/**
 * Deep-sanitize an object's string values recursively.
 * Useful for sanitizing entire IPC payloads or tool outputs.
 */
export function sanitizeObjectStrings<T>(obj: T): T {
  if (typeof obj === 'string') return sanitizeUnicode(obj) as T;
  if (Array.isArray(obj)) return obj.map(sanitizeObjectStrings) as T;
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = sanitizeObjectStrings(value);
    }
    return result as T;
  }
  return obj;
}
