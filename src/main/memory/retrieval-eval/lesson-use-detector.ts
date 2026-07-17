/**
 * WS16 — cheap, deterministic "was this surfaced lesson actually USED?" signal.
 *
 * The loop surfaces lessons into PLAN prior-context as text. When a later
 * iteration's output (NOTES append, plan edit, or explicit response) echoes a
 * surfaced lesson, that is a use signal → `LessonStore.reinforceOnUse`. This
 * detector is the heuristic the plan calls for ("lesson id echoed, or strong
 * text overlap"), kept pure and spec'd so the reinforcement stays measurable.
 *
 * Detection = significant-token overlap (content-token coverage ≥ a
 * threshold) OR an explicit lesson-id mention. Conservative by design: a false
 * positive over-reinforces a lesson (mild ranking noise), so the threshold is
 * set high enough that only a real echo trips it.
 */

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'for', 'with',
  'is', 'are', 'be', 'it', 'this', 'that', 'as', 'at', 'by', 'from', 'you',
  'your', 'we', 'i', 'not', 'do', 'so', 'if', 'when', 'before', 'after', 'they',
]);

/** Light suffix stem so tense/plural variants match (acquire/acquired, suite/suites). */
function stem(token: string): string {
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (token.length > suffix.length + 2 && token.endsWith(suffix)) {
      return token.slice(0, -suffix.length);
    }
  }
  return token;
}

function contentTokens(text: string): Set<string> {
  const tokens = (text.toLowerCase().match(/[a-z0-9_]+/g) ?? [])
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token))
    .map(stem);
  return new Set(tokens);
}

/**
 * Fraction of the LESSON's content tokens that appear in the text (overlap
 * coefficient over the lesson side). Unlike Jaccard this does not penalize
 * long iteration text — "is the lesson referenced here" is a coverage
 * question, not a similarity one.
 */
function lessonCoverage(lessonTokens: Set<string>, textTokens: Set<string>): number {
  if (lessonTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of lessonTokens) if (textTokens.has(token)) intersection++;
  return intersection / lessonTokens.size;
}

export interface DetectableLesson {
  id: string;
  text: string;
}

/**
 * Return the ids of surfaced lessons that the given text references. A lesson
 * matches when its id appears verbatim OR its content-token coverage against
 * the text clears `threshold`.
 */
export function detectUsedLessons(
  text: string,
  surfaced: readonly DetectableLesson[],
  threshold = 0.5,
): string[] {
  if (!text.trim() || surfaced.length === 0) return [];
  const textTokens = contentTokens(text);
  const used: string[] = [];
  for (const lesson of surfaced) {
    if (text.includes(lesson.id)) {
      used.push(lesson.id);
      continue;
    }
    if (lessonCoverage(contentTokens(lesson.text), textTokens) >= threshold) {
      used.push(lesson.id);
    }
  }
  return used;
}
