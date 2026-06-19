import type { LoopState, PingPongSubject } from '../../shared/types/loop.types';

export interface PingPongIntentResult {
  subject: PingPongSubject;
  confidence: number;
  reason: string;
}

const PLAN_KEYWORDS = [
  'plan',
  'design',
  'spec',
  'specification',
  'architecture',
  'proposal',
  'rfc',
  'outline',
  'strategy',
  'approach',
];

const IMPL_KEYWORDS = [
  'implement',
  'fix',
  'build',
  'refactor',
  'add ',
  'write ',
  'code',
  'bug',
  'feature',
  'migrate',
  'wire',
  'integrate',
];

function countMatches(haystack: string, needles: readonly string[]): number {
  let n = 0;
  for (const w of needles) {
    if (haystack.includes(w)) n++;
  }
  return n;
}

/**
 * Heuristic plan-vs-impl classifier for the kickoff prompt (precedent: the
 * loop's LF-2 semantic-progress check). Cheap and deterministic so it can run
 * every round. Defaults to `'impl'` on low confidence (safer — impl mode runs
 * verify, bigchange_pingpong_review R6).
 */
export function classifyPingPongSubjectHeuristic(input: {
  goal: string;
  planFile?: string;
  initialStage?: string;
  producedProductionChanges?: boolean;
  override?: 'auto' | PingPongSubject;
}): PingPongIntentResult {
  if (input.override === 'plan' || input.override === 'impl') {
    return { subject: input.override, confidence: 1, reason: 'explicit override' };
  }

  // Strong structural signals first.
  if (input.producedProductionChanges) {
    return {
      subject: 'impl',
      confidence: 0.9,
      reason: 'production code changed this run',
    };
  }
  if (input.planFile && input.initialStage === 'PLAN') {
    return { subject: 'plan', confidence: 0.85, reason: 'plan file + PLAN initial stage' };
  }

  const goal = (input.goal || '').toLowerCase();
  const planScore = countMatches(goal, PLAN_KEYWORDS);
  const implScore = countMatches(goal, IMPL_KEYWORDS);

  if (planScore > implScore && planScore > 0) {
    const confidence = Math.min(0.8, 0.5 + 0.1 * (planScore - implScore));
    return { subject: 'plan', confidence, reason: `plan keywords (${planScore} vs ${implScore})` };
  }
  if (implScore > 0) {
    const confidence = Math.min(0.8, 0.5 + 0.1 * (implScore - planScore));
    return { subject: 'impl', confidence, reason: `impl keywords (${implScore} vs ${planScore})` };
  }

  // Low confidence → default impl (safer).
  return { subject: 'impl', confidence: 0.3, reason: 'no strong signal — default impl' };
}

/**
 * Per-round subject resolver used by the ping-pong completion branch. Re-runs
 * each round (a task can move from planning into implementation mid-run —
 * bigchange_pingpong_review §4.10). Honors the configured override.
 */
export function resolvePingPongSubject(state: LoopState, _fullOutput: string): PingPongSubject {
  const override = state.config.completion.crossModelReview?.pingPong?.subject;
  const producedProductionChanges =
    (state.lastIteration?.filesChanged?.length ?? 0) > 0;
  return classifyPingPongSubjectHeuristic({
    goal: state.config.initialPrompt,
    planFile: state.config.planFile,
    initialStage: state.config.initialStage,
    producedProductionChanges,
    override,
  }).subject;
}
