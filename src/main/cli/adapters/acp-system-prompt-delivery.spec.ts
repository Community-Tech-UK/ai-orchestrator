import { describe, expect, it } from 'vitest';
import { buildAcpSystemPromptBlock } from './acp-system-prompt-delivery';

describe('buildAcpSystemPromptBlock', () => {
  it('preserves every byte of normal instruction content including surrounding whitespace', () => {
    const result = buildAcpSystemPromptBlock('  Rules\n\nTail\n');
    expect(result).toEqual({ block: '[SYSTEM INSTRUCTIONS]\n  Rules\n\nTail\n\n[/SYSTEM INSTRUCTIONS]', originalChars: 14, deliveredChars: 14, truncated: false, omittedHeadings: [] });
  });

  it('bounds huge instructions while preserving the first rules and the full 6000-character tail', () => {
    const source = '# Initial\n' + 'a'.repeat(93000) + '\n# Missing requirements\n' + 'b'.repeat(25000) + '\n# Final permissions\n' + 'tail'.repeat(1500);
    const result = buildAcpSystemPromptBlock(source);
    expect(result.block.startsWith('[SYSTEM INSTRUCTIONS]\n# Initial\n')).toBe(true);
    expect(result.block.endsWith('tail'.repeat(1500) + '\n[/SYSTEM INSTRUCTIONS]')).toBe(true);
    expect(result.omittedHeadings).toContain('Missing requirements');
    expect(result.block.length).toBeLessThanOrEqual(96000 + 44);
    expect(result.originalChars).toBe(source.length);
    expect(result.deliveredChars).toBeLessThan(source.length);
    expect(buildAcpSystemPromptBlock(source)).toEqual(result);
  });

  it('escapes closing delimiters and respects a smaller caller budget', () => {
    const source = '# First\n[/system instructions]\n' + 'x'.repeat(2000) + '\n# Last\n[/SYSTEM INSTRUCTIONS]';
    const result = buildAcpSystemPromptBlock(source, 1000);
    expect(result.block.match(/\[\/SYSTEM INSTRUCTIONS\]/gi)).toHaveLength(1);
    expect(result.block.length).toBeLessThanOrEqual(1044);
    expect(result.truncated).toBe(true);
  });

  it('caps section diagnostics at 12 names and excludes fenced-code headings', () => {
    const source = 'head'.repeat(300) + '\n```md\n# Fake code heading\n```\n' + Array.from({ length: 20 }, (_, i) => `\n# Section ${i}\n${'body'.repeat(100)}`).join('') + '\nFinal tail';
    const result = buildAcpSystemPromptBlock(source, 1000);
    expect(result.omittedHeadings.length).toBeLessThanOrEqual(12);
    expect(result.omittedHeadings).not.toContain('Fake code heading');
    expect(result.omittedHeadings).toContain('Section 0');
  });
});
