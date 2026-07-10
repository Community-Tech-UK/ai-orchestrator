/**
 * Fence- and prose-tolerant JSON extraction for review-agent responses.
 *
 * Reviewers are instructed to return ONLY JSON, but real responses often wrap
 * the payload in markdown fences or quote code (containing braces) before it.
 * A naive first-brace..last-bracket slice spans prose+code+JSON, fails to
 * parse, and silently drops every finding — so we scan for the first balanced,
 * PARSEABLE span instead, preferring one shaped like findings.
 */

/** Extract the JSON payload from a review agent's raw response, or null. */
export function extractReviewJson(raw: string): string | null {
  return extractLastJsonPayload(raw, isFindingsPayload)
    ?? extractLastJsonPayload(raw);
}

/**
 * Return the last parseable JSON payload accepted by `accept`, regardless of
 * whether it is fenced or embedded in prose. Reviewers often quote a fenced
 * example before emitting their final bare payload.
 */
export function extractLastJsonPayload(
  raw: string,
  accept: (value: unknown) => boolean = () => true,
): string | null {
  const text = (raw || '').trim();
  if (!text) return null;

  let lastAccepted: { candidate: string; sourceIndex: number } | null = null;
  const fencedBlocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)];
  for (const match of fencedBlocks) {
    const candidate = match[1]?.trim();
    if (!candidate) continue;
    const parsed = tryParse(candidate);
    if (parsed !== undefined && accept(parsed)) {
      lastAccepted = { candidate, sourceIndex: match.index ?? 0 };
    }
  }

  const entire = tryParse(text);
  if (entire !== undefined && accept(entire)) return text;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '{' && ch !== '[') continue;
    const candidate = extractBalancedSpan(text, i);
    if (!candidate) continue;
    const parsed = tryParse(candidate);
    if (parsed === undefined || !accept(parsed)) continue;
    if (!lastAccepted || i >= lastAccepted.sourceIndex) {
      lastAccepted = { candidate, sourceIndex: i };
    }
    i += candidate.length - 1; // skip past this span
  }
  return lastAccepted?.candidate ?? null;
}

function tryParse(candidate: string): unknown | undefined {
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

function isFindingsPayload(value: unknown): boolean {
  return Array.isArray(value) || Boolean(value && typeof value === 'object' && 'issues' in value);
}

/** Extract the balanced `{...}`/`[...]` span starting at `start` (string-aware). */
export function extractBalancedSpan(text: string, start: number): string | null {
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
