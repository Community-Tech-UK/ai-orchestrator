/** Prefix for live denials and typed held-call notes; plain held Reject keeps its legacy reason. */
export const HARNESS_DENY_PREFIX = 'Harness: the user declined this call. ';
export const HARNESS_INTERACTIVE_DENY = HARNESS_DENY_PREFIX
  + 'The question is shown to them on screen; end your turn and wait for their reply.';
/**
 * Prefix for refusals no person saw: a saved rule, the automatic reviewer, or a
 * call Claude would have had to ask about in a session nobody is driving. The
 * permission hooks (`src/main/cli/hooks/*.mjs`) repeat this text; a spec keeps
 * them equal.
 */
export const HARNESS_UNASKED_PREFIX = 'Harness: nobody was asked about this call. ';

/** The text the model receives when a held or live call is refused. */
export function harnessRefusal(answer: { note?: string; autoReason?: string }, fallback: string): string {
  if (answer.autoReason?.trim()) return HARNESS_UNASKED_PREFIX + answer.autoReason.trim();
  return answer.note?.trim() ? HARNESS_DENY_PREFIX + answer.note.trim() : fallback;
}

/** True for refusal text Harness wrote itself; it is never a CLI denial to act on. */
export function isHarnessRefusal(content: string): boolean {
  const text = content.trimStart();
  return text.startsWith(HARNESS_DENY_PREFIX) || text.startsWith(HARNESS_UNASKED_PREFIX);
}
