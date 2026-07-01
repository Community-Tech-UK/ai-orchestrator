import * as path from 'path';
import type { LoopConfig, LoopIteration } from '../../shared/types/loop.types';
import { completedPlanFileCandidates } from './loop-completion-detector';

export interface VerifyOutcomeLike {
  status: 'passed' | 'skipped' | 'failed';
  output: string;
  failureKind?: 'command' | 'timeout' | 'infra';
}

export function applyVerifyOutcomeToIteration(iteration: LoopIteration, outcome: VerifyOutcomeLike): void {
  iteration.verifyStatus = outcome.status === 'skipped' ? 'not-run' : outcome.status;
  iteration.verifyOutputExcerpt = excerpt(outcome.output);
  iteration.verifyFailureKind = outcome.status === 'failed' ? outcome.failureKind : undefined;
}

export function verifyFailureIntervention(
  friendlyLabel: string,
  output: string,
  failureKind: VerifyOutcomeLike['failureKind'],
): string {
  const excerpted = excerpt(output, 8192) || `(${friendlyLabel} produced no output)`;
  if (failureKind === 'infra') {
    return `Your completion was rejected because the ${friendlyLabel} command could not be started. ` +
      'This is a verification infrastructure failure, not evidence that the code/tests are wrong. ' +
      'Fix the verify command environment or report it as blocked, then re-declare completion:\n\n' +
      excerpted;
  }
  if (failureKind === 'timeout') {
    return `Your completion was rejected because the ${friendlyLabel} command timed out before producing a reliable result. ` +
      'Treat this as verifier infrastructure unless the output clearly identifies a real hung test. ' +
      'Fix the timeout/hang cause or report it as blocked, then re-declare completion:\n\n' +
      excerpted;
  }
  return `Your completion was rejected because the ${friendlyLabel} command failed. ` +
    'Fix these errors before re-declaring completion:\n\n' +
    excerpted;
}

export function selectedVerifyFailureKind(
  primary: VerifyOutcomeLike,
  final: VerifyOutcomeLike,
): VerifyOutcomeLike['failureKind'] {
  if (final !== primary && final.status === 'failed') return final.failureKind;
  return primary.status === 'failed' ? primary.failureKind : undefined;
}

export interface OperatorReviewPauseMessages {
  failure: string;
  intervention: string;
}

export function buildOperatorReviewPauseMessages(args: {
  freshEyesErrored: boolean;
  verifyStatus: VerifyOutcomeLike['status'];
}): OperatorReviewPauseMessages {
  const verifyPassedButReviewErrored = args.freshEyesErrored && args.verifyStatus === 'passed';
  if (verifyPassedButReviewErrored) {
    return {
      failure:
        'Completion cannot be auto-confirmed: verify passed, but the configured fresh-eyes ' +
        'review could not produce a verdict (the reviewers returned unparseable output, ' +
        'or none were available). The loop is pausing for operator review instead of ' +
        'silently bypassing the review gate. Inspect the work and accept it manually, or ' +
        'fix the reviewer setup and keep iterating.',
      intervention:
        'Your completion was NOT accepted. Verify passed, but the configured fresh-eyes ' +
        'review could not produce a verdict this time (the reviewers returned unparseable ' +
        'output, or none were available). Do not simply re-declare completion — it will ' +
        'be rejected again until a fresh-eyes review succeeds or the operator accepts the work. ' +
        'The loop is pausing for operator review.',
    };
  }
  if (args.freshEyesErrored) {
    return {
      failure:
        'Completion cannot be auto-confirmed: the fresh-eyes review that would ' +
        'independently verify this loop could not produce a verdict (the reviewers ' +
        'returned unparseable output, or none were available). No verify command is ' +
        'configured as a fallback, so the loop is pausing for operator review. Inspect ' +
        'the work and accept it manually, or fix the reviewer setup (or add a verify ' +
        'command) and keep iterating.',
      intervention:
        'Your completion was NOT accepted. The fresh-eyes review that would independently ' +
        'confirm it could not produce a verdict this time (the reviewers returned ' +
        'unparseable output, or none were available). Do not simply re-declare completion ' +
        '— it will be rejected again until an independent review succeeds. The loop is ' +
        'pausing for operator review.',
    };
  }
  return {
    failure:
      'Completion cannot be confirmed: no verify command is configured and fresh-eyes ' +
      'review is not enabled, so the loop has no independent way to check the work is ' +
      'actually done. Configure a verify command (your test / lint / build command) or ' +
      'enable fresh-eyes review before starting a loop that should auto-complete, or ' +
      'inspect the reported evidence and stop the loop manually.',
    intervention:
      'Your completion was NOT accepted. This loop has no verify command configured and ' +
      'fresh-eyes review is not enabled, so it cannot independently confirm the work is ' +
      'finished. Do not simply re-declare completion — it will be rejected again. The ' +
      'loop is pausing for operator review because only the operator can decide whether ' +
      'your reported verification evidence is sufficient without an independent verify command.',
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function excerpt(s: string, max = 4096): string {
  if (!s) return '';
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return s.slice(0, half) + '\n…\n' + s.slice(-half);
}

/**
 * Generous safety bound for the verbatim agent closing message persisted on
 * each iteration as `outputFull`. Realistic closing messages are a few KB;
 * 100k chars (~25k tokens) guarantees no real response is ever cut, while
 * still bounding a pathological output so it can't bloat the loop DB or the
 * live state payload.
 *
 * This is deliberately distinct from {@link excerpt}, which keeps a tiny
 * head+tail string used for similarity / no-progress / completion detection.
 * `outputFull` exists purely for human display (summary card, trace, chat
 * recap), so it keeps the whole message rather than a head+tail slice.
 */
export const MAX_LOOP_OUTPUT_FULL_CHARS = 100_000;

export function boundFullOutput(s: string): string {
  if (!s) return '';
  if (s.length <= MAX_LOOP_OUTPUT_FULL_CHARS) return s;
  return (
    `${s.slice(0, MAX_LOOP_OUTPUT_FULL_CHARS).trimEnd()}\n` +
    `…(truncated — output exceeded ${MAX_LOOP_OUTPUT_FULL_CHARS.toLocaleString('en-US')} chars; ` +
    'see the child instance transcript for the remainder)'
  );
}

function tokenize(s: string): Set<string> {
  return new Set(
    s.toLowerCase()
      .replace(/[^a-z0-9_\s]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 0),
  );
}

export function jaccard(a: string, b: string): number {
  const A = tokenize(a);
  const B = tokenize(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union > 0 ? inter / union : 0;
}

export function completedPlanWatchDirs(config: LoopConfig): string[] {
  return [...new Set(completedPlanFileCandidates(config).map((candidate) => path.dirname(candidate)))];
}
