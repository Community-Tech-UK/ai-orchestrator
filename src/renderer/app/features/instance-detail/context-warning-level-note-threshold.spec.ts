import { describe, expect, it } from 'vitest';
import { resolveClaudeContextNote } from './context-warning-level';

describe('resolveClaudeContextNote once the summary trigger is reached', () => {
  const ceilings = { machineContextCeilingTokens: 400_000, ownChatContextCeilingTokens: 400_000 };
  // Claude summarises at ceiling minus 33K, so 367K here.
  const at = (used: number) => ({
    provider: 'claude', selfManagesAutoCompaction: true,
    contextUsage: { used, total: 1_000_000, percentage: 30, occupancyReported: true },
  });

  it('still counts down while tokens remain', () => {
    expect(resolveClaudeContextNote(at(366_000), ceilings))
      .toBe('Claude will summarise this conversation in about 1K tokens.');
  });

  it('says nothing at the trigger or past it, instead of promising "about 0 tokens"', () => {
    expect(resolveClaudeContextNote(at(367_000), ceilings)).toBeNull();
    expect(resolveClaudeContextNote(at(367_400), ceilings)).toBeNull();
    expect(resolveClaudeContextNote(at(390_000), ceilings)).toBeNull();
  });

  it('never produces a zero-token sentence anywhere across the whole range', () => {
    for (let used = 260_000; used <= 420_000; used += 250) {
      const note = resolveClaudeContextNote(at(used), ceilings);
      if (note !== null) expect(note).not.toMatch(/about 0K? tokens/);
    }
  });
});
