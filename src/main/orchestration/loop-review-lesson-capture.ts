/**
 * Fable WS6 Task 4 — review/debate → lessons.
 *
 * Cross-model review and debate outcomes used to evaporate: a fresh-eyes
 * reviewer would block completion with a concrete finding, the loop would fix
 * it, and nothing durable was learned. This module closes that gap. When a
 * review produces a substantive verdict (blocking fresh-eyes findings,
 * ping-pong issues, or a debate synthesis), it distills a single generalizable
 * one-line lesson via the auxiliary `memoryDistillation` slot and captures it
 * into the process-wide {@link LessonStore}, whose `capture()` performs the
 * normalized-text dedup ("reinforce, don't duplicate") the plan pins.
 *
 * Design notes:
 *  - The distilled lesson text is kept PURE (no source tags mangled in) so the
 *    store's normalized-text dedup stays effective across review rounds. Source
 *    metadata is surfaced via the returned {@link ReviewLessonResult.source}
 *    for the caller to log/emit, not baked into the lesson body.
 *  - The aux slot's `fallback` source means no real model ran (local/frontier
 *    unavailable). We skip capture in that case rather than persist a canned
 *    fallback string — a wrong lesson is worse than no lesson.
 *  - Everything is injected for testability; failures degrade to `null`.
 *    Lesson capture must never block or crash a review gate.
 */

import { getLogger } from '../logging/logger';

const logger = getLogger('LoopReviewLessonCapture');

/** Source of the review verdict a lesson is distilled from. */
export type ReviewLessonKind = 'fresh-eyes' | 'ping-pong' | 'debate';

export interface ReviewLessonFinding {
  title: string;
  body: string;
  severity?: string;
  file?: string;
}

export interface ReviewLessonInput {
  kind: ReviewLessonKind;
  /** The loop's goal — anchors the lesson to what was being attempted. */
  goal: string;
  /** Reviewer providers that produced the verdict (for the prompt + logging). */
  reviewers: readonly string[];
  /** The blocking findings / issues the verdict raised. */
  findings: readonly ReviewLessonFinding[];
  /** Plain-English review summary or debate synthesis, when available. */
  summary?: string;
}

export interface ReviewLessonDeps {
  /**
   * Auxiliary `memoryDistillation` generation. Returns the model text plus the
   * source that produced it (`fallback` ⇒ no real model ran ⇒ skip capture).
   */
  distill: (systemPrompt: string, userPrompt: string) => Promise<{ text: string; source: string }>;
  /** Persist the lesson (LessonStore.capture — dedups by normalized text). */
  captureLesson: (text: string) => { reinforced: boolean };
}

export interface ReviewLessonResult {
  lesson: string;
  kind: ReviewLessonKind;
  reinforced: boolean;
}

/** Hard cap on a distilled lesson so a runaway model can't bloat the store. */
const MAX_LESSON_CHARS = 200;

const LESSON_SYSTEM_PROMPT = [
  'You distill ONE durable engineering lesson from a code-review outcome.',
  'Output a single imperative sentence, generalizable to future work on this codebase,',
  'that would have prevented the finding. No preamble, no markdown, no quotes, one line.',
  'If there is no transferable lesson (e.g. a one-off typo), output exactly: NONE',
].join(' ');

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function buildDistillPrompt(input: ReviewLessonInput): string {
  const findingsBlock = input.findings
    .slice(0, 8)
    .map((f, i) => {
      const loc = f.file ? ` (${f.file})` : '';
      const sev = f.severity ? `[${f.severity}] ` : '';
      return `${i + 1}. ${sev}${oneLine(f.title)}${loc}\n   ${oneLine(f.body).slice(0, 400)}`;
    })
    .join('\n');
  const summaryBlock = input.summary ? `\n\nReviewer summary:\n${oneLine(input.summary).slice(0, 600)}` : '';
  return (
    `Goal being attempted: ${oneLine(input.goal).slice(0, 400)}\n\n`
    + `A ${input.kind} review (${input.reviewers.join(', ') || 'reviewers'}) raised:\n`
    + `${findingsBlock}${summaryBlock}`
  );
}

/**
 * Distill and capture a lesson from a review/debate verdict. Returns the
 * captured lesson, or `null` when nothing worth persisting surfaced (no
 * findings, aux fallback, empty/`NONE` output, or any thrown error).
 */
export async function captureReviewLesson(
  input: ReviewLessonInput,
  deps: ReviewLessonDeps,
): Promise<ReviewLessonResult | null> {
  if (input.findings.length === 0 && !input.summary?.trim()) {
    return null;
  }

  let raw: { text: string; source: string };
  try {
    raw = await deps.distill(LESSON_SYSTEM_PROMPT, buildDistillPrompt(input));
  } catch (err) {
    logger.warn('Review-lesson distillation failed (skipped)', {
      kind: input.kind,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  // `fallback` ⇒ no real model ran; don't persist a canned string.
  if (raw.source === 'fallback') {
    return null;
  }

  const lesson = oneLine(raw.text)
    .replace(/^["'`]+|["'`]+$/g, '')
    .slice(0, MAX_LESSON_CHARS)
    .trim();
  if (!lesson || lesson.toUpperCase() === 'NONE') {
    return null;
  }

  try {
    const { reinforced } = deps.captureLesson(lesson);
    logger.info('Captured review lesson', {
      kind: input.kind,
      reviewers: input.reviewers,
      reinforced,
    });
    return { lesson, kind: input.kind, reinforced };
  } catch (err) {
    logger.warn('Review-lesson capture failed (skipped)', {
      kind: input.kind,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
