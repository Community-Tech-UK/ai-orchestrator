/**
 * JSON.stringify that escapes U+2028 and U+2029.
 * These are valid JSON but act as line terminators in JavaScript,
 * silently splitting NDJSON messages when present in string values.
 */
export function ndjsonSafeStringify(value: unknown): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Upper bound (chars) on each input considered by the similarity helper. Inputs
 * longer than this are truncated before trigram extraction so the comparison
 * stays O(bounded) on the degraded-output path rather than O(n) in the full
 * response size.
 */
const SIMILARITY_MAX_CHARS = 16_384;

export function computeBoundedTrigramSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const sa = a.length > SIMILARITY_MAX_CHARS ? a.slice(0, SIMILARITY_MAX_CHARS) : a;
  const sb = b.length > SIMILARITY_MAX_CHARS ? b.slice(0, SIMILARITY_MAX_CHARS) : b;

  const trigrams = (s: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i + 3 <= s.length; i++) {
      set.add(s.slice(i, i + 3));
    }
    return set;
  };

  const ta = trigrams(sa);
  const tb = trigrams(sb);
  if (ta.size === 0 || tb.size === 0) {
    return 0;
  }

  let intersection = 0;
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  for (const gram of small) {
    if (large.has(gram)) intersection++;
  }
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
