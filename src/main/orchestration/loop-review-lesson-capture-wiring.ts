/**
 * Fable WS6 Task 4 — production wiring for review-lesson capture.
 *
 * Keeps {@link loop-review-lesson-capture} a pure, singleton-free module (so its
 * unit tests stay light) while binding the aux `memoryDistillation` slot, the
 * `loopSurfaceLessons` gate, and the process-wide lesson store here. All of it
 * is fire-and-forget: a failure must never affect the review gate or the loop.
 */

import { getLogger } from '../logging/logger';
import { getSettingsManager } from '../core/config/settings-manager';
import { getAuxiliaryLlmService } from '../rlm/auxiliary-llm-service';
import { getLessonStore } from '../memory/lesson-store';
import { getGovernedProposalService } from '../memory/governed-proposal-service';
import { redactForEgress } from '../security/content-egress-gate';
import { getLLMService } from '../rlm/llm-service';
import { runAuthorizedFrontierFallback } from '../local-ai-guard/local-ai-cost-correlation';
import {
  captureReviewLesson,
  type ReviewLessonKind,
} from './loop-review-lesson-capture';

const logger = getLogger('LoopReviewLessonCaptureWiring');

export interface ReviewVerdictForLesson {
  reviewers: string[];
  findings: { title: string; body: string; severity?: string; file?: string }[];
  summary: string;
}

/**
 * Distill a blocking review/debate verdict into a durable lesson. Gated by
 * `loopSurfaceLessons` (default ON); never throws.
 */
export function captureReviewLessonForVerdict(opts: {
  loopRunId: string;
  goal: string;
  kind: ReviewLessonKind;
  verdict: ReviewVerdictForLesson;
}): void {
  let lessonsEnabled = true;
  try {
    lessonsEnabled = (getSettingsManager().getAll() as { loopSurfaceLessons?: boolean }).loopSurfaceLessons ?? true;
  } catch { /* default ON */ }
  if (!lessonsEnabled) return;

  void captureReviewLesson(
    {
      kind: opts.kind,
      goal: opts.goal,
      reviewers: opts.verdict.reviewers,
      findings: opts.verdict.findings,
      summary: opts.verdict.summary,
    },
    {
      distill: async (systemPrompt, userPrompt) => {
        // WS3: findings can quote secret-bearing source lines and the aux slot
        // may run on a remote frontier model — gate the prompt before egress.
        const gatedPrompt = redactForEgress(userPrompt, { kind: 'prompt' }).content;
        const { text, decision } = await getAuxiliaryLlmService().generate('memoryDistillation', systemPrompt, gatedPrompt);
        if (decision.source === 'fallback' && decision.allowFrontierFallback) {
          const frontierText = await runAuthorizedFrontierFallback(
            decision,
            () => getLLMService().generate(systemPrompt, gatedPrompt),
          );
          return { text: frontierText, source: 'frontier' };
        }
        return { text, source: decision.source };
      },
      captureLesson: (text) => {
        // WS3: memory writes get a memory-kind scan (redact, don't drop).
        const gatedText = redactForEgress(text, { kind: 'memory' }).content;
        const { reinforced } = getLessonStore().capture(gatedText);
        // WS-A4: parallel governance record — the direct lesson-capture path
        // above is unchanged; this only raises/reinforces a review-inbox
        // proposal so a human can promote or reject the agent-derived lesson.
        // Fail-soft by design (captureMemoryProposal never throws).
        getGovernedProposalService().captureMemoryProposal({
          text: gatedText,
          sourceSessionId: opts.loopRunId,
        });
        return { reinforced };
      },
    },
  ).catch((err) => {
    logger.warn('Review-lesson capture failed (skipped)', {
      loopRunId: opts.loopRunId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}
