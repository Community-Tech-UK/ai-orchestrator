/**
 * Detect reasoning that has collapsed into a repeated short phrase.
 *
 * Observed on OpenCode session ses_f0656fc4fffeS5nIGSwKTcBpD4 (Harness
 * instance iaki24ipc, MiMo v2.6 Pro): the last step finished with reason
 * `length`, 32,004 reasoning tokens and 0 output tokens. The thought tail was
 * thousands of `Hmm.` lines. OpenCode exits its agent loop on any finish other
 * than tool-calls, and ACP reports that as `end_turn`, so Harness recorded a
 * normal completion and the session went idle.
 */

const MIN_REPEATS = 24;
const MAX_PHRASE_CHARS = 40;

/**
 * Detect short repeated phrases anywhere in a thinking block. Fixed-period
 * scans are linear in the block size, with a bounded period of eight words.
 * A final fragment cannot undo a run already observed before a token cutoff.
 */
export function isCollapsedReasoning(text: string): boolean {
  if (typeof text !== 'string') return false;
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  if (hasPeriodicRun(lines, 2, false)) return true;
  // Restrict inline scans to each line: ordinary repeated multi-line prose
  // whose full line exceeds the phrase ceiling retains the previous veto.
  return lines.some((line) => hasPeriodicRun(line.match(/[^\s.!?]+[.!?]*|[.!?]+/g) ?? [], 8));
}

function hasPeriodicRun(parts: readonly string[], maxPeriod: number, countCycles = true): boolean {
  for (let period = 1; period <= maxPeriod; period += 1) {
    let matched = 0;
    for (let index = period; index < parts.length; index += 1) {
      matched = parts[index] === parts[index - period] ? matched + 1 : 0;
      if (matched < (countCycles ? (MIN_REPEATS - 1) * period : MIN_REPEATS - period)) continue;
      if (parts.slice(index - period + 1, index + 1).join(' ').length <= MAX_PHRASE_CHARS) return true;
    }
  }
  return false;
}

/** True when any thinking block, or the blocks joined in order, has collapsed. */
export function hasCollapsedReasoning(
  value: unknown,
): boolean {
  const blocks = readReasoningBlocks(value);
  if (blocks.length === 0) return false;
  if (blocks.some((block) => isCollapsedReasoning(block.content))) return true;
  return isCollapsedReasoning(blocks.map((block) => block.content).join('\n'));
}

/** Adapter and recorded payloads can carry text or malformed optional fields. */
export function readReasoningBlocks(value: unknown): { content: string; id?: string }[] {
  if (typeof value === 'string') return [{ content: value }];
  if (!Array.isArray(value)) return [];
  return value.flatMap((block: unknown) => {
    if (!block || typeof block !== 'object') return [];
    const entry = block as Record<string, unknown>;
    return typeof entry['content'] === 'string'
      ? [{ content: entry['content'], ...(typeof entry['id'] === 'string' ? { id: entry['id'] } : {}) }]
      : [];
  });
}
