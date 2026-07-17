/**
 * WS16 — agent-facing retrieval query sanitizer ("mempalace ladder").
 *
 * Agents frequently paste an entire tool result, a whole file, or a multi-
 * paragraph rationale into a search box. A 2 000-char "query" wrecks BM25 (it
 * matches everything) and blows embedding token budgets. This recovers the
 * SEARCH INTENT with a deterministic, dependency-free ladder — never an LLM
 * call — applied only when a query exceeds the threshold:
 *
 *   1. If the text contains question sentences, keep the LAST one (the actual
 *      ask usually comes after the context dump).
 *   2. Else keep the last meaningful non-empty line (tail intent).
 *   3. Else hard-truncate to the cap.
 * Then strip surrounding quotes/backticks and collapse whitespace.
 *
 * The RAW query is preserved by the caller in the recall trace so offline
 * analysis can compare sanitized-vs-raw retrieval quality.
 */

export const QUERY_SANITIZE_THRESHOLD = 300;
const HARD_CAP = 300;

export interface SanitizedQuery {
  query: string;
  sanitized: boolean;
  /** Which ladder rung produced the result (for traces/telemetry). */
  strategy: 'unchanged' | 'last-question' | 'tail-line' | 'truncated';
}

function stripWrappers(text: string): string {
  let out = text.trim();
  // Strip a single layer of matching surrounding quotes/backticks.
  const pairs: Array<[string, string]> = [['"', '"'], ["'", "'"], ['`', '`']];
  for (const [open, close] of pairs) {
    if (out.length >= 2 && out.startsWith(open) && out.endsWith(close)) {
      out = out.slice(1, -1).trim();
      break;
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

export function sanitizeRetrievalQuery(raw: string): SanitizedQuery {
  const trimmed = (raw ?? '').trim();
  if (trimmed.length <= QUERY_SANITIZE_THRESHOLD) {
    return { query: trimmed, sanitized: false, strategy: 'unchanged' };
  }

  // Rung 1: last question sentence.
  const questions = trimmed.match(/[^.!?\n]*\?/g);
  if (questions && questions.length > 0) {
    const candidate = stripWrappers(questions[questions.length - 1]);
    if (candidate.length > 0 && candidate.length <= HARD_CAP) {
      return { query: candidate, sanitized: true, strategy: 'last-question' };
    }
    if (candidate.length > HARD_CAP) {
      return { query: candidate.slice(0, HARD_CAP).trim(), sanitized: true, strategy: 'truncated' };
    }
  }

  // Rung 2: last meaningful line.
  const lines = trimmed
    .split('\n')
    .map((line) => stripWrappers(line))
    .filter((line) => line.length > 0);
  const tail = lines[lines.length - 1];
  if (tail && tail.length <= HARD_CAP) {
    return { query: tail, sanitized: true, strategy: 'tail-line' };
  }

  // Rung 3: hard truncate.
  return {
    query: stripWrappers(trimmed).slice(0, HARD_CAP).trim(),
    sanitized: true,
    strategy: 'truncated',
  };
}
