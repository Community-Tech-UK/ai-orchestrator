/**
 * D6 (#7) — anti-self-grading helpers for completion claims.
 *
 * "Only the verifier issues a verdict": when the agent's own `complete`
 * claim admits the work is partial/caveated (3b), or cites only a *targeted*
 * verification run where the full verify command is configured (part 2), the
 * claim must not count as a completion signal — the verify flow / fresh-eyes
 * gate is the only authority that grades work. Consumed by
 * `LoopCompletionDetector.observe` (gated on `config.completion.antiSelfGrading`).
 *
 * Pure module: no I/O, no state.
 */

import type { LoopTerminalIntentEvidence } from '../../shared/types/loop-state.types';
import { matchClaimedVerifyCommand } from './loop-canonical-command';

/**
 * Patterns are deliberately conservative (explicit incompleteness markers
 * only): a false positive merely costs one extra iteration, but the list
 * still avoids wording that legitimately appears in a *clean* completion
 * summary. Notably EXCLUDED:
 * - "deferred" — deferring a ledger item with a reason is an allowed
 *   resolution (`[-]`), so mentioning it is not a caveat;
 * - "follow-up" — recording a follow-up spec is the sanctioned way to park
 *   out-of-scope work.
 * Noun-first phrasing is required for the "remaining" family ("3 tasks
 * remain", "issues remaining") so "fixed the remaining issues" — a completion
 * statement — does not match.
 */
const SELF_ASSIGNED_CAVEAT_PATTERNS: readonly RegExp[] = [
  /\bpartial(?:ly)?\b/i,
  /\bincomplete\b/i,
  /\bunfinished\b/i,
  /\bhalf[- ]done\b/i,
  /\bwork[- ]in[- ]progress\b/i,
  /\bwip\b/i,
  /\bnot\s+(?:yet\s+)?(?:done|complete|completed|finished|implemented|verified|tested|working)\b/i,
  /\bstill\s+(?:needs?|failing|broken|pending|outstanding|missing|todo|to\s+do)\b/i,
  /\b(?:work|items?|tasks?|issues?|failures?|tests?)\s+(?:still\s+)?remain(?:s|ing)?\b/i,
  /\bexcept\b/i,
  /\bcaveats?\b/i,
  /\bcould(?:\s+not|n'?t)\s+(?:run|verify|test|complete|finish|fix)\b/i,
  /\bunable\s+to\s+(?:run|verify|test|complete|finish|fix)\b/i,
  /\btests?\s+(?:are\s+|were\s+)?(?:skipped|failing|not\s+run)\b/i,
  /\btodos?\s+(?:left|remain(?:ing)?)\b/i,
  /\bmost(?:ly)?\s+(?:done|complete|working)\b/i,
];

/**
 * Returns the first self-assigned PARTIAL/caveat phrase found in a
 * completion-claim summary, or null when the claim is clean. The matched
 * phrase is surfaced verbatim in the demoted signal's detail so the operator
 * (and the next iteration's prompt) can see exactly why the claim did not
 * count.
 */
export function findSelfAssignedCaveat(text: string): string | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  for (const re of SELF_ASSIGNED_CAVEAT_PATTERNS) {
    const match = re.exec(text);
    if (match) return match[0];
  }
  return null;
}

/**
 * D6 (#7) part 2 — targeted-verify masquerade detection.
 *
 * When a complete intent's structured evidence cites verification commands,
 * check them against the configured verify command with the canonical matcher.
 * Returns the offending claimed command when the BEST claim is only a
 * `'targeted'` narrowing (one test file, a `-k` filter) of the configured
 * command — a subset run must not masquerade as repo-green. Deliberately
 * lenient otherwise:
 * - any `'full'`-equivalent claim clears the intent (the agent really ran it);
 * - claims that are all `'unrelated'` are NOT punished — the agent is not
 *   required to run verify itself (the coordinator runs it at the gate), so
 *   citing a grep or a build step is not a masquerade;
 * - no command evidence at all is fine for the same reason.
 */
export function findTargetedVerifyMasquerade(
  evidence: readonly LoopTerminalIntentEvidence[],
  configuredVerifyCommand: string,
): string | null {
  const configured = (configuredVerifyCommand || '').trim();
  if (!configured) return null;
  const claims = evidence
    .filter((e) => e.kind === 'command' || e.kind === 'test')
    .map((e) => e.value)
    .filter((v) => typeof v === 'string' && v.trim().length > 0);
  if (claims.length === 0) return null;

  let targetedClaim: string | null = null;
  for (const claim of claims) {
    const match = matchClaimedVerifyCommand(claim, configured);
    if (match === 'full') return null;
    if (match === 'targeted' && targetedClaim === null) targetedClaim = claim;
  }
  return targetedClaim;
}

/** Minimal durable-execution shape used by the detector. The ledger is the
 * authority for scope whenever it has rows; terminal-intent text is only a
 * compatibility fallback for commands AIO did not observe. */
export interface ObservedVerificationCommand {
  command: string;
}

export interface TargetedVerifyMasquerade {
  command: string;
  source: 'observed' | 'unobserved-claim';
}

/**
 * Prefer coordinator-observed commands over an agent's self-reported command.
 * A full observed execution clears earlier targeted executions because the
 * scope concern has been answered by a real full run. If no durable rows are
 * available, retain the pre-ledger claim check and label that weaker evidence
 * honestly for the next iteration/operator.
 */
export function findTargetedVerifyMasqueradeWithExecution(
  evidence: readonly LoopTerminalIntentEvidence[],
  configuredVerifyCommand: string,
  verificationRuns: readonly ObservedVerificationCommand[] | undefined,
): TargetedVerifyMasquerade | null {
  if (verificationRuns && verificationRuns.length > 0) {
    let targetedCommand: string | null = null;
    for (const run of verificationRuns) {
      const command = typeof run.command === 'string' ? run.command.trim() : '';
      if (!command) continue;
      const match = matchClaimedVerifyCommand(command, configuredVerifyCommand);
      if (match === 'full') return null;
      if (match === 'targeted' && targetedCommand === null) targetedCommand = command;
    }
    return targetedCommand === null
      ? null
      : { command: targetedCommand, source: 'observed' };
  }

  const claimedCommand = findTargetedVerifyMasquerade(evidence, configuredVerifyCommand);
  return claimedCommand === null
    ? null
    : { command: claimedCommand, source: 'unobserved-claim' };
}
