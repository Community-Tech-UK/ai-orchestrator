import type { LoopIteration } from '../../shared/types/loop.types';
import { parseAgentMoreWorkRemaining } from './loop-completion-detector';
import { claimsCompletion } from './safety-critic';

const POSITIVE_VERIFICATION_RE =
  /\b(?:test|tests|pytest|vitest|jest|jasmine|lint|eslint|tsc|typecheck|type-check|build|mvn\s+test|maven|gradle|compil(?:e|ed|es))\b[\s\S]{0,160}\b(?:pass(?:ed|ing)?|green|success(?:ful)?|succeeded|0\s+fail(?:ed|ures?))\b/i;
const NEGATIVE_VERIFICATION_RE =
  /\b(?:test|tests|pytest|vitest|jest|jasmine|lint|eslint|tsc|typecheck|type-check|build|mvn\s+test|maven|gradle|compil(?:e|ed|es))\b[\s\S]{0,160}\b(?:fail(?:ed|ing|ure|ures)?|errored?|red|broken)\b/i;

function hasPositiveVerificationEvidence(iteration: LoopIteration): boolean {
  if (iteration.verifyStatus === 'passed') return true;
  if (iteration.verifyStatus === 'failed') return false;
  if ((iteration.testFailCount ?? 0) > 0) return false;
  if ((iteration.testPassCount ?? 0) > 0) return true;
  const output = iteration.outputFull || iteration.outputExcerpt || '';
  return POSITIVE_VERIFICATION_RE.test(output) && !NEGATIVE_VERIFICATION_RE.test(output);
}

export function isVerifiedNoChangeCompletionClaim(iteration: LoopIteration): boolean {
  const output = iteration.outputFull || iteration.outputExcerpt || '';
  return !parseAgentMoreWorkRemaining(output)
    && claimsCompletion(output)
    && hasPositiveVerificationEvidence(iteration);
}
