import { describe, expect, it } from 'vitest';
import {
  buildContextRecoveryBlock,
  CONTEXT_RECOVERY_LOOKUP_SENTENCE,
} from './context-recovery-block';

describe('buildContextRecoveryBlock', () => {
  it('states the count and the exact read_session call as facts', () => {
    const block = buildContextRecoveryBlock(412);
    expect(block).toContain('The 412 messages before this reset are still in this session.');
    expect(block).toContain('{"session": "self", "from": "before-last-compaction"}');
    expect(block).toContain('page back with `before`');
  });

  it('keeps the look-up instruction out of the block (it lives in the final rule)', () => {
    const block = buildContextRecoveryBlock(412);
    expect(block).not.toContain(CONTEXT_RECOVERY_LOOKUP_SENTENCE);
    expect(CONTEXT_RECOVERY_LOOKUP_SENTENCE).toContain('look it up with the `read_session` call in `<context_recovery>`');
  });

  it('falls back to a generic first line when there is no count', () => {
    expect(buildContextRecoveryBlock()).toContain('The messages before this reset are still in this session.');
    expect(buildContextRecoveryBlock(0)).toContain('The messages before this reset are still in this session.');
    expect(buildContextRecoveryBlock()).not.toContain('The 0 messages');
    expect(buildContextRecoveryBlock(0)).not.toContain('The 0 messages');
  });

  it('escapes any closing tag in the body like the package blocks do', () => {
    expect(buildContextRecoveryBlock(1)).not.toMatch(/<\/context_recovery>[\s\S]*<\/context_recovery>/);
    const block = buildContextRecoveryBlock(1);
    expect(block.startsWith('<context_recovery>\n')).toBe(true);
    expect(block.endsWith('\n</context_recovery>')).toBe(true);
  });
});
