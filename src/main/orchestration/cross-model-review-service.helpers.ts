/**
 * Pure helpers for parsing reviewer JSON responses.
 * Extracted from CrossModelReviewService to keep the class file focused.
 */

/**
 * Extract JSON from a reviewer response, handling common model output quirks:
 * markdown fences, preamble text, trailing commentary, nested braces.
 */
export function extractJson(rawResponse: string): unknown | null {
  let cleaned = rawResponse.trim();

  // Strategy 1: Extract from markdown fences (```json ... ``` or ``` ... ```)
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  // Strategy 2: Direct parse (works when model follows instructions perfectly)
  try {
    return JSON.parse(cleaned);
  } catch {
    // continue to fallback strategies
  }

  // Strategy 3: Find the outermost balanced JSON object
  const jsonStart = cleaned.indexOf('{');
  if (jsonStart >= 0) {
    const candidate = extractBalancedJson(cleaned, jsonStart);
    if (candidate) {
      try {
        return JSON.parse(candidate);
      } catch {
        // continue
      }
    }

    // Strategy 4: Greedy regex fallback (last resort)
    const greedyMatch = cleaned.match(/\{[\s\S]*\}/);
    if (greedyMatch) {
      try {
        return JSON.parse(greedyMatch[0]);
      } catch {
        // all strategies exhausted
      }
    }
  }

  return null;
}

/**
 * Extract a balanced JSON object starting at the given index.
 * Tracks brace depth to avoid grabbing trailing text.
 */
export function extractBalancedJson(text: string, startIdx: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }
  return null;
}
