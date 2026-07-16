/**
 * Loop intent detection.
 *
 * Some loop goals carry an explicit "converge until clean" intent — the
 * canonical example is "keep doing a review with fresh eyes and fix any
 * issues, until there are no issues." For that intent the loop should not
 * stop on the agent's own say-so: it must run an independent fresh-eyes
 * cross-model review before accepting completion. The coordinator uses this
 * detector to auto-enable `completion.crossModelReview` when the caller did
 * not explicitly configure it (an explicit `{ enabled: false }` still wins).
 *
 * The detector is intentionally conservative — it favours false negatives
 * (no auto-enable) over false positives (surprising the user with extra
 * cross-CLI calls). A strong, unambiguous "fresh eyes" mention is sufficient
 * on its own; otherwise we require BOTH a review/audit verb AND a
 * convergence cue ("until no issues", "until clean", "keep reviewing",
 * "repeatedly", …).
 */

import type { LoopGoalIntent } from '../types/loop.types';

/** "fresh eyes" / "fresh-eyes" anywhere is a strong, unambiguous signal. */
const FRESH_EYES_RE = /\bfresh[\s-]?eyes\b/i;

/** Verbs that indicate the user wants an evaluative pass, not just edits. */
const REVIEW_VERB_RE = /\b(re-?review|review|reviewing|critique|critiquing|audit|auditing|vet|vetting|inspect|inspecting)\b/i;

/**
 * Cues that the user wants the work repeated until a clean state — i.e. the
 * loop should converge on "no issues" rather than stop after one pass.
 */
const CONVERGENCE_CUE_RES: RegExp[] = [
  /\buntil\s+(?:there\s+are\s+)?(?:no|zero|0)\s+(?:more\s+)?(?:issues?|problems?|bugs?|errors?|findings?|defects?|concerns?)\b/i,
  /\buntil\s+(?:it'?s\s+|they'?re\s+|everything\s+is\s+|the\s+code\s+is\s+)?clean\b/i,
  /\buntil\s+(?:there\s+are\s+)?none(?:\s+left)?\b/i,
  /\buntil\s+(?:it\s+)?(?:passes|converges|is\s+done|is\s+complete)\b/i,
  /\b(?:keep|continue)\s+(?:reviewing|review|critiquing|auditing|iterating|going|fixing)\b/i,
  /\brepeatedly\b/i,
  /\bover\s+and\s+over\b/i,
  /\b(?:fix|resolve|address)\s+(?:any|all|every|the)\s+(?:issues?|problems?|bugs?|errors?|findings?)\b.*\buntil\b/i,
];

export interface ConvergeUntilCleanDetection {
  matched: boolean;
  /** Short machine-readable reason, useful for logs/telemetry. */
  reason: 'fresh-eyes-phrase' | 'review-verb+convergence-cue' | 'none';
}

/**
 * Inspect the loop's goal (and optional continuation directive) for the
 * "converge until clean" intent. Returns a structured result so callers can
 * log *why* the intent was (or wasn't) detected.
 */
export function detectConvergeUntilCleanIntent(
  initialPrompt: string,
  iterationPrompt?: string,
): ConvergeUntilCleanDetection {
  const text = `${initialPrompt ?? ''}\n${iterationPrompt ?? ''}`;

  if (FRESH_EYES_RE.test(text)) {
    return { matched: true, reason: 'fresh-eyes-phrase' };
  }

  const hasReviewVerb = REVIEW_VERB_RE.test(text);
  const hasConvergenceCue = CONVERGENCE_CUE_RES.some((re) => re.test(text));
  if (hasReviewVerb && hasConvergenceCue) {
    return { matched: true, reason: 'review-verb+convergence-cue' };
  }

  return { matched: false, reason: 'none' };
}

/** Convenience boolean wrapper around {@link detectConvergeUntilCleanIntent}. */
export function looksLikeConvergeUntilCleanIntent(
  initialPrompt: string,
  iterationPrompt?: string,
): boolean {
  return detectConvergeUntilCleanIntent(initialPrompt, iterationPrompt).matched;
}

// ===========================================================================
// Goal-intent classification (implementation vs investigation)
// ===========================================================================

/**
 * Imperative verbs that mean the user wants the agent to CHANGE code. Matched
 * as whole base-form words, so participles like "implemented" / "fixed" /
 * "built" (which appear in questions such as "is this implemented?") do NOT
 * trigger — only the imperative base form does. Implementation always wins on
 * ambiguity: a goal that asks for a code change is an implementation task even
 * when phrased as a question ("can you fix X?").
 */
const IMPLEMENTATION_VERB_RE =
  /\b(implement|fix|build|add|create|refactor|rewrite|write|update|modify|ship|migrate|rename|delete|remove|install|wire|integrate|optimi[sz]e|repair|patch|scaffold|generate|hook\s+up|set\s+up|finish\s+implementing|complete\s+the|make\s+it\s+work)\b/i;

/** Verbs that clearly request an explanation / assessment, not a code change. */
const INVESTIGATION_VERB_RE =
  /\b(explain|describe|summari[sz]e|audit|investigate|analy[sz]e|assess|clarify|tell\s+me|find\s+out|report\s+on|walk\s+me\s+through|how\s+does|why\s+does|what\s+(?:is|are|does|happens|causes))\b/i;

/** Interrogative lead at the very start of the goal (optionally after "please"). */
const QUESTION_LEAD_RE =
  /^\s*(?:please\s+)?(?:can|could|would|will|do|does|did|is|are|was|were|has|have|should|what|why|how|where|which|who|whose|when|whether)\b/i;

/** "is this/it/the X … done/implemented/complete/…" status question. */
const STATUS_QUESTION_RE =
  /\bis\s+(?:this|it|that|the\s+\w+)\b[^?]*\b(?:done|implemented|complete|completed|finished|working|correct|ready|wired|in\s+place)\b/i;

export interface LoopGoalIntentDetection {
  intent: LoopGoalIntent;
  /** Short machine-readable reason, useful for logs/telemetry. */
  reason:
    | 'implementation-verb'
    | 'investigation-verb'
    | 'question-form'
    | 'status-question'
    | 'default'
    | 'empty';
}

/**
 * Classify a loop GOAL as an implementation task or an investigation
 * (question / audit / "explain X" / "is Y done?").
 *
 * Classifies the goal ONLY — deliberately NOT the continuation/iteration
 * directive. In the renderer the iteration prompt defaults to a generic
 * "continue toward the goal… update the code… rename it with _completed…"
 * boilerplate (`DEFAULT_LOOP_PROMPT`) that is full of implementation verbs;
 * folding it into the text would misclassify every audit goal typed in the
 * textarea as implementation. The user's actual ask lives in `initialPrompt`.
 *
 * Deliberately conservative and asymmetric: a misread that turns an IMPLEMENT
 * goal into an investigation would stop the loop from doing the work the user
 * asked for, so implementation is the safe default and wins on ambiguity.
 * Investigation is only returned when the goal has NO imperative implementation
 * verb AND reads unmistakably as a question/audit.
 */
export function detectLoopGoalIntent(goal: string): LoopGoalIntentDetection {
  const g = (goal ?? '').trim();
  if (!g) return { intent: 'implementation', reason: 'empty' };

  // 1. Any imperative implementation verb → implementation (wins on ambiguity).
  if (IMPLEMENTATION_VERB_RE.test(g)) {
    return { intent: 'implementation', reason: 'implementation-verb' };
  }

  // 2. Explicit explain/audit verb → investigation.
  if (INVESTIGATION_VERB_RE.test(g)) {
    return { intent: 'investigation', reason: 'investigation-verb' };
  }

  // 3. "is this X done/implemented?" status question → investigation.
  if (STATUS_QUESTION_RE.test(g)) {
    return { intent: 'investigation', reason: 'status-question' };
  }

  // 4. Interrogative lead AND an actual question mark → investigation.
  if (QUESTION_LEAD_RE.test(g) && /\?/.test(g)) {
    return { intent: 'investigation', reason: 'question-form' };
  }

  // 5. Default: treat as implementation.
  return { intent: 'implementation', reason: 'default' };
}

/**
 * WS6: single classification seam shared by `prepareLoopStartConfig`, the
 * coordinator's `startLoop`, and the renderer's start panel — the same input
 * must resolve to the same intent everywhere the verification policy is
 * evaluated. An explicit caller-supplied intent always wins ("ambiguous
 * intent remains implementation" is the detector's default).
 */
export function resolveLoopGoalIntent(
  explicitIntent: LoopGoalIntent | undefined,
  initialPrompt: string,
): { intent: LoopGoalIntent; reason: string; explicit: boolean } {
  if (explicitIntent !== undefined) {
    return { intent: explicitIntent, reason: 'explicit', explicit: true };
  }
  const detected = detectLoopGoalIntent(initialPrompt);
  return { intent: detected.intent, reason: detected.reason, explicit: false };
}
