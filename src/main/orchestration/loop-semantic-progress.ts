/**
 * LF-2 — Semantic progress signal (loopfixex.md).
 *
 * Syntactic progress signals (identical-work-hash, churn, output-similarity)
 * cannot tell "done-idling" from "stuck-idling": a converged loop that keeps
 * touching NOTES.md looks identical to a wedged loop that keeps retrying the
 * same broken edit. This module adds a cheap, model-based "did the latest
 * iteration actually advance the goal?" check that acts purely as an
 * **escalation modifier** over the structural verdict — it is NEVER the sole
 * authority to stop or continue a loop.
 *
 * Design (mirrors `loop-fresh-eyes-reviewer.ts`):
 *  - `LoopSemanticProgressReviewer` is an injectable function (DI), so tests
 *    stub it and production uses {@link defaultSemanticProgressReviewer}.
 *  - The escalation logic lives in the pure, unit-tested helpers
 *    {@link shouldRunSemanticCheck} and {@link reconcileSemanticVerdict} — the
 *    coordinator only wires them together.
 *  - Default OFF (`LoopSemanticProgressConfig.enabled === false`): zero
 *    behavioural change and zero model cost until a loop opts in.
 *
 * Escalation rules (both require confirmation across two consecutive checks,
 * mirroring the weak-signal FU-4 confirmation in the progress detector):
 *  - structural WARN + confirmed "did NOT advance" ⇒ upgrade to CRITICAL.
 *  - structural CRITICAL that is *solely* churn-based (signals A/B/H) +
 *    confirmed "DID advance" ⇒ soften to WARN (the loop is genuinely
 *    progressing through a refactor that merely looks like churn).
 */

import type {
  LoopSemanticProgressConfig,
  LoopSemanticProgressResult,
  LoopVerdict,
  ProgressSignalEvidence,
  ProgressSignalId,
} from '../../shared/types/loop.types';

// ============ Reviewer (DI) ============

export interface LoopSemanticProgressReviewerInput {
  /** The user's goal — what "progress" is measured against. */
  goal: string;
  /** Workspace root (for reviewers that want to inspect the tree). */
  workspaceCwd: string;
  /** Paths the latest iteration changed (best-effort; may be empty). */
  filesChangedThisIteration: readonly string[];
  /** The latest iteration's stdout excerpt (agent self-narration; context). */
  iterationOutput: string;
  /**
   * Optional grounding excerpt — task ledger / plan / NOTES tail. Lets the
   * reviewer compare against the declared remaining work rather than guessing.
   */
  progressContext?: string;
  /** Active semantic-progress config (cadence, confidence floor, …). */
  config: LoopSemanticProgressConfig;
}

export type LoopSemanticProgressReviewer = (
  input: LoopSemanticProgressReviewerInput,
) => Promise<LoopSemanticProgressResult>;

/**
 * Fail-safe neutral verdict. `confidence: 0` is below any valid floor, so a
 * neutral result can never trigger an escalation or suppression — a broken or
 * unavailable reviewer leaves the structural verdict untouched.
 */
export const NEUTRAL_SEMANTIC_RESULT: LoopSemanticProgressResult = {
  advanced: true,
  whatChanged: '(semantic progress reviewer unavailable)',
  confidence: 0,
};

/**
 * Default reviewer — a single cheap LLM call via the existing RLM
 * `LLMService`. Lazily required so test paths and disabled loops never pull in
 * the LLM stack. Any failure (no LLM available, network, malformed output)
 * degrades to {@link NEUTRAL_SEMANTIC_RESULT}.
 */
/**
 * Hard cap on the default reviewer's whole LLM round-trip (availability probe +
 * sub-query). A slow or hung provider must never stall a loop iteration; on
 * timeout the reviewer yields the neutral result (confidence 0 ⇒ ignored by the
 * escalation logic), exactly like any other failure. Injected custom reviewers
 * are responsible for their own bounding.
 */
export const DEFAULT_SEMANTIC_REVIEW_TIMEOUT_MS = 30_000;

export const defaultSemanticProgressReviewer: LoopSemanticProgressReviewer = (input) =>
  withSemanticTimeout(runDefaultSemanticReview(input), DEFAULT_SEMANTIC_REVIEW_TIMEOUT_MS);

async function runDefaultSemanticReview(
  input: LoopSemanticProgressReviewerInput,
): Promise<LoopSemanticProgressResult> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getLLMService } = require('../rlm/llm-service') as typeof import('../rlm/llm-service');
    const llm = getLLMService();
    if (!(await llm.isAvailable())) return NEUTRAL_SEMANTIC_RESULT;

    const filesBlock = input.filesChangedThisIteration.length
      ? `Files changed by the latest iteration:\n${input.filesChangedThisIteration
          .slice(0, 40)
          .map((f) => `  - ${f}`)
          .join('\n')}`
      : '(no files reported changed by the latest iteration)';
    const outputBlock = input.iterationOutput.trim()
      ? `Latest iteration output (the agent's own summary — treat with skepticism):\n${input.iterationOutput.slice(0, 4000)}`
      : '(no iteration output captured)';
    const context = [
      `GOAL:\n${input.goal}`,
      input.progressContext ? `REMAINING-WORK / NOTES:\n${input.progressContext.slice(0, 4000)}` : '',
      filesBlock,
      outputBlock,
    ]
      .filter(Boolean)
      .join('\n\n');

    const prompt =
      'Judge whether the LATEST iteration of an autonomous coding loop made ' +
      'measurable progress toward the GOAL, as opposed to spinning/churning ' +
      'without advancing. Respond with ONLY a JSON object and no other text:\n' +
      '{"advanced": <true|false>, "whatChanged": "<one short sentence>", "confidence": <number 0..1>}\n' +
      'Set "advanced" to true ONLY if the latest iteration meaningfully moved ' +
      'toward the goal. Set "confidence" to how sure you are (0 = a guess).';

    const raw = await llm.subQuery({
      requestId: `loop-semantic-${Date.now()}`,
      prompt,
      context,
      depth: 0,
    });
    return parseSemanticResult(raw);
  } catch {
    return NEUTRAL_SEMANTIC_RESULT;
  }
}

/**
 * Resolve `operation`, or {@link NEUTRAL_SEMANTIC_RESULT} if it does not settle
 * within `timeoutMs`. Never rejects (a rejected operation also degrades to
 * neutral). Exported for testing. The timer is unref'd so a pending bound never
 * keeps the process alive on its own.
 */
export function withSemanticTimeout(
  operation: Promise<LoopSemanticProgressResult>,
  timeoutMs: number,
): Promise<LoopSemanticProgressResult> {
  return new Promise<LoopSemanticProgressResult>((resolve) => {
    let settled = false;
    const finish = (result: LoopSemanticProgressResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish(NEUTRAL_SEMANTIC_RESULT), timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    operation.then(finish, () => finish(NEUTRAL_SEMANTIC_RESULT));
  });
}

/**
 * Parse the reviewer's raw text into a {@link LoopSemanticProgressResult}.
 * Tolerant of leading/trailing prose around the JSON; clamps confidence to
 * [0,1]; degrades to neutral on any malformed input. Exported for testing.
 */
export function parseSemanticResult(raw: string): LoopSemanticProgressResult {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return NEUTRAL_SEMANTIC_RESULT;
    const obj = JSON.parse(match[0]) as Partial<LoopSemanticProgressResult>;
    const advanced = typeof obj.advanced === 'boolean' ? obj.advanced : true;
    const confidenceRaw = typeof obj.confidence === 'number' && Number.isFinite(obj.confidence) ? obj.confidence : 0;
    const confidence = Math.max(0, Math.min(1, confidenceRaw));
    const whatChanged = typeof obj.whatChanged === 'string' ? obj.whatChanged.slice(0, 500) : '';
    return { advanced, whatChanged, confidence };
  } catch {
    return NEUTRAL_SEMANTIC_RESULT;
  }
}

// ============ Pure escalation logic (unit-tested) ============

/**
 * Cadence gate. Returns true when a semantic check should run this iteration.
 * Runs whenever there is a structural concern (WARN/CRITICAL) so the verdict
 * can be confirmed/softened, plus a cheap periodic sanity check every
 * `cadence` iterations while OK. Never runs when disabled or every iteration
 * unconditionally (cost control).
 */
export function shouldRunSemanticCheck(params: {
  enabled: boolean;
  structuralVerdict: LoopVerdict;
  seq: number;
  cadence: number;
}): boolean {
  const { enabled, structuralVerdict, seq, cadence } = params;
  if (!enabled) return false;
  if (structuralVerdict !== 'OK') return true;
  return cadence > 0 && seq > 0 && seq % cadence === 0;
}

/**
 * Signal ids treated as "churn-based" — a CRITICAL verdict composed *solely*
 * of these can be softened by a confident "did advance" semantic verdict.
 * A = identical-work-hash, B = edit churn, H = output similarity. Structural
 * signals (test stagnation D', stage stagnation C, error repeat E, …) are
 * never softened by the semantic check.
 */
export const CHURN_SIGNAL_IDS: ReadonlySet<ProgressSignalId> = new Set<ProgressSignalId>(['A', 'B', 'H']);

export interface SemanticReconcileInput {
  structuralVerdict: LoopVerdict;
  structuralSignals: readonly ProgressSignalEvidence[];
  current: LoopSemanticProgressResult;
  /** Most recent prior semantic result (for two-consecutive-check confirmation). */
  previous: LoopSemanticProgressResult | null;
  confidenceFloor: number;
}

export interface SemanticReconcileResult {
  verdict: LoopVerdict;
  /** True iff the semantic check changed the structural verdict. */
  changed: boolean;
  reason: string;
}

/**
 * Reconcile the structural verdict with the semantic verdict. Returns the
 * (possibly modified) verdict. NEVER flips on a single check: a verdict change
 * requires the current AND previous semantic checks to both be confident
 * (≥ floor) and agree. This makes the semantic signal a confirmation-gated
 * modifier, not a sole authority.
 */
export function reconcileSemanticVerdict(input: SemanticReconcileInput): SemanticReconcileResult {
  const { structuralVerdict, structuralSignals, current, previous, confidenceFloor } = input;
  const unchanged = (reason: string): SemanticReconcileResult => ({
    verdict: structuralVerdict,
    changed: false,
    reason,
  });

  if (current.confidence < confidenceFloor) {
    return unchanged(`semantic confidence ${current.confidence.toFixed(2)} < floor ${confidenceFloor} — unchanged`);
  }

  const previousConfirms =
    !!previous && previous.confidence >= confidenceFloor && previous.advanced === current.advanced;
  if (!previousConfirms) {
    return unchanged('semantic verdict not yet confirmed by a second consecutive check — unchanged');
  }

  // Upgrade: WARN + confirmed "did NOT advance" ⇒ CRITICAL.
  if (structuralVerdict === 'WARN' && !current.advanced) {
    return {
      verdict: 'CRITICAL',
      changed: true,
      reason: `semantic check confirms no progress (2×, conf ${current.confidence.toFixed(2)}) — WARN escalated to CRITICAL`,
    };
  }

  // Suppress: CRITICAL composed solely of churn signals + confirmed "did advance" ⇒ WARN.
  if (structuralVerdict === 'CRITICAL' && current.advanced) {
    const criticalSignals = structuralSignals.filter((s) => s.verdict === 'CRITICAL');
    const churnOnly = criticalSignals.length > 0 && criticalSignals.every((s) => CHURN_SIGNAL_IDS.has(s.id));
    if (churnOnly) {
      return {
        verdict: 'WARN',
        changed: true,
        reason: `semantic check confirms real progress (2×, conf ${current.confidence.toFixed(2)}) despite churn-only signals — CRITICAL softened to WARN`,
      };
    }
    return unchanged('CRITICAL includes non-churn structural signals — not softened by semantic progress');
  }

  return unchanged('semantic verdict aligned with structural verdict — no change');
}

/**
 * Find the most recent prior semantic result in the iteration history (newest
 * first). Used to supply the "previous" check for two-consecutive confirmation.
 */
export function findPreviousSemanticResult(
  history: readonly { semanticProgress?: LoopSemanticProgressResult }[],
): LoopSemanticProgressResult | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const sp = history[i]?.semanticProgress;
    if (sp) return sp;
  }
  return null;
}
