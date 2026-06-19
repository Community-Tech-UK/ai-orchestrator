/**
 * Resume-with-answers prompt builder (Outstanding panel, Slice 2).
 *
 * Turns a set of human-answered outstanding items (the "Needs human" / "Open
 * questions" the previous loop flagged, now annotated with the operator's
 * decision) into a single kickoff prompt for a fresh loop run. The new run
 * applies those decisions instead of re-asking. Pure + deterministic (no clock,
 * no IO) so it is trivially unit-testable; the handler owns config reuse + start.
 */

import type { LoopOutstandingItem } from '../../shared/types/loop.types';

export interface ResumeWithAnswersInput {
  /** Open items that carry a non-empty human answer — fed back as decisions. */
  answered: LoopOutstandingItem[];
  /** Open items still without an answer — listed as context, not decisions. */
  unanswered: LoopOutstandingItem[];
  /** The original loop goal (iteration-0 prompt), pinned for continuity. */
  originalGoal?: string;
}

function kindLabel(kind: LoopOutstandingItem['kind']): string {
  return kind === 'needs-human' ? 'Needs human' : 'Open question';
}

/** Indent every line of a (possibly multi-line) value by two spaces. */
function indent(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join('\n');
}

/**
 * Build the kickoff prompt for a resumed run. Throws when there are no answered
 * items — there is nothing to feed back, so the caller should not start a run.
 */
export function buildResumeWithAnswersPrompt(input: ResumeWithAnswersInput): string {
  if (input.answered.length === 0) {
    throw new Error('buildResumeWithAnswersPrompt requires at least one answered item');
  }

  const lines: string[] = [
    'A previous loop run paused with items that needed a human decision. Those',
    'decisions have now been made — apply them and continue the work.',
    '',
  ];

  if (input.originalGoal?.trim()) {
    lines.push('## Original goal', '', input.originalGoal.trim(), '');
  }

  lines.push('## Decisions to apply', '');
  input.answered.forEach((item, i) => {
    lines.push(`${i + 1}. [${kindLabel(item.kind)}] ${item.text}`);
    lines.push(indent(`Decision: ${(item.userResponse ?? '').trim()}`));
    lines.push('');
  });

  if (input.unanswered.length > 0) {
    lines.push(
      '## Still unanswered',
      '',
      'These remain open with no decision. Use your best judgement; if you still',
      'cannot resolve one autonomously, keep it in OUTSTANDING.md under "Needs human".',
      '',
    );
    for (const item of input.unanswered) {
      lines.push(`- [${kindLabel(item.kind)}] ${item.text}`);
    }
    lines.push('');
  }

  lines.push(
    '## What to do now',
    '',
    'Apply the decisions above, then continue implementing toward the original',
    'goal. Update OUTSTANDING.md so resolved items are removed. Verify your work',
    'and only finish when the verification gate passes.',
  );

  return lines.join('\n');
}
