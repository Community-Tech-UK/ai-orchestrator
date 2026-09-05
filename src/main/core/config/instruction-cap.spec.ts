import { describe, expect, it } from 'vitest';

import {
  capInstructionPrompts,
  capResolvedInstructionStack,
  INSTRUCTION_FILE_MAX_CHARS,
  INSTRUCTION_STACK_MAX_CHARS,
} from './instruction-cap';

const line = (n: number) => `${'x'.repeat(79)}\n`.repeat(n);

describe('capInstructionPrompts', () => {
  it('leaves a stack inside both budgets completely untouched', () => {
    const parts = ['# Project rules\nBe careful.', '# User rules\nBe brief.'];
    const result = capInstructionPrompts(parts, ['AGENTS.md', 'CLAUDE.md']);
    expect(result.parts).toEqual(parts);
    expect(result.trimmed).toEqual([]);
    expect(result.dropped).toEqual([]);
  });

  it('trims a file over the per-file budget and names it in the notice', () => {
    const big = line(400); // ~32k chars
    const result = capInstructionPrompts([big], ['AGENTS.md'], { fileMaxChars: 1_000 });
    expect(result.parts[0]!.length).toBeLessThan(big.length);
    expect(result.trimmed).toEqual(['AGENTS.md']);
    expect(result.parts[0]).toContain('AGENTS.md');
    expect(result.parts[0]).toContain('slim this file');
  });

  it('drops whole files once the stack budget is spent, and says which', () => {
    const result = capInstructionPrompts(
      [line(20), line(20), line(20)],
      ['a.md', 'b.md', 'c.md'],
      { fileMaxChars: 10_000, stackMaxChars: 1_200 },
    );
    expect(result.dropped).toEqual(['b.md', 'c.md']);
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]).toContain('omitted entirely: b.md, c.md');
  });

  it('keeps the head of a file, since the top is where the rules are', () => {
    const text = `FIRST LINE MATTERS\n${line(400)}`;
    const [out] = capInstructionPrompts([text], ['AGENTS.md'], { fileMaxChars: 500 }).parts;
    expect(out).toContain('FIRST LINE MATTERS');
  });

  it('never emits more than the stack budget plus its own notices', () => {
    const result = capInstructionPrompts(
      [line(500), line(500)],
      ['a.md', 'b.md'],
      { fileMaxChars: 20_000, stackMaxChars: 5_000 },
    );
    const contentChars = result.parts
      .join('')
      .replace(/\n\n\.\.\. \((truncated|omitted entirely)[^)]*\)/g, '')
      .length;
    expect(contentChars).toBeLessThanOrEqual(5_000);
  });

  /**
   * The injection site is inside the WS-B4 byte-stable prompt-cache prefix
   * contract. If this output varied at all — a timestamp, a count, set
   * iteration order — every fresh spawn would miss the cache it was built to
   * hit, which is the opposite of what T10 is for.
   */
  it('is byte-identical across repeated calls with identical input', () => {
    const parts = [line(500), line(300)];
    const labels = ['a.md', 'b.md'];
    const first = capInstructionPrompts(parts, labels, { stackMaxChars: 4_000 });
    const second = capInstructionPrompts(parts, labels, { stackMaxChars: 4_000 });
    expect(first).toEqual(second);
    expect(first.parts.join('|')).toBe(second.parts.join('|'));
  });

  it('cuts on a line boundary rather than mid-line when one is available', () => {
    const [out] = capInstructionPrompts([line(100)], ['a.md'], { fileMaxChars: 1_000 }).parts;
    const body = out!.split('\n\n... (')[0]!;
    expect(body.endsWith('x')).toBe(true);
    // Every retained line is whole.
    for (const l of body.split('\n')) {
      if (l.length > 0) expect(l).toHaveLength(79);
    }
  });

  it('falls back to a hard cut when the first line alone exceeds the budget', () => {
    const oneHugeLine = 'y'.repeat(5_000);
    const [out] = capInstructionPrompts([oneHugeLine], ['a.md'], { fileMaxChars: 100 }).parts;
    expect(out!.startsWith('y'.repeat(100))).toBe(true);
    expect(out).toContain('truncated');
  });

  it('names a part positionally when no label was supplied, rather than throwing', () => {
    const result = capInstructionPrompts([line(400)], [], { fileMaxChars: 500 });
    expect(result.trimmed).toEqual(['instruction file 1']);
  });

  it('handles an empty stack', () => {
    expect(capInstructionPrompts([], [])).toEqual({ parts: [], trimmed: [], dropped: [] });
  });

  /**
   * The budgets are a guardrail against pathological growth, not a routine
   * trimmer. Pinned against this machine's real measured stack: the largest
   * single instruction file is 23,752 chars and the whole stack is 35,456. A
   * cap that fires on THAT would be silently deleting operating rules — the
   * plan's cited 20,000 per file would have cut the Fresh-Eyes Gate out of the
   * user-global CLAUDE.md.
   */
  it('does not fire on a healthy real-world stack', () => {
    const realLargestFile = 23_752;
    const realWholeStack = 35_456;
    expect(INSTRUCTION_FILE_MAX_CHARS).toBeGreaterThan(realLargestFile);
    expect(INSTRUCTION_STACK_MAX_CHARS).toBeGreaterThan(realWholeStack);
    expect(INSTRUCTION_STACK_MAX_CHARS).toBeGreaterThan(INSTRUCTION_FILE_MAX_CHARS);
  });

  it('still bounds a genuinely pathological stack', () => {
    // Three 40k-char files: over both budgets, and ~40k tokens per spawn.
    const huge = [line(506), line(506), line(506)];
    const result = capInstructionPrompts(huge, ['a.md', 'b.md', 'c.md']);
    expect(result.trimmed.length + result.dropped.length).toBeGreaterThan(0);
    expect(result.parts.join('').length).toBeLessThan(huge.join('').length);
  });
});

/**
 * The arithmetic above is only half the job: the cap has to actually receive a
 * real resolver result, with the split and the label pairing intact. "Existence
 * is not behaviour" — a util that is never reached caps nothing.
 */
describe('capResolvedInstructionStack', () => {
  const source = (label: string) => ({ label, path: `/tmp/${label}`, loaded: true, applied: true });

  it('splits a merged stack back into its parts and labels them from the applied sources', () => {
    const resolution = {
      mergedContent: ['AAAA', 'BBBB'].join('\n\n---\n\n'),
      sources: [source('AGENTS.md'), source('CLAUDE.md')],
    };
    expect(capResolvedInstructionStack(resolution).parts).toEqual(['AAAA', 'BBBB']);
  });

  it('ignores sources the resolver did not apply when pairing labels', () => {
    const resolution = {
      mergedContent: line(400),
      sources: [
        { label: 'skipped.md', path: '/tmp/skipped.md', loaded: true, applied: false },
        source('AGENTS.md'),
      ],
    };
    const result = capResolvedInstructionStack(resolution, { fileMaxChars: 500 });
    expect(result.trimmed).toEqual(['AGENTS.md']);
  });

  it('returns nothing for an empty resolution rather than a single empty part', () => {
    expect(capResolvedInstructionStack({ mergedContent: '', sources: [] })).toEqual({
      parts: [], trimmed: [], dropped: [],
    });
  });

  it('caps a realistic oversized stack end to end', () => {
    const resolution = {
      mergedContent: [line(2000), line(2000), line(2000)].join('\n\n---\n\n'),
      sources: [source('a.md'), source('b.md'), source('c.md')],
    };
    const before = resolution.mergedContent.length;
    const result = capResolvedInstructionStack(resolution);
    const after = result.parts.join('').length;
    expect(before).toBeGreaterThan(INSTRUCTION_STACK_MAX_CHARS);
    // Notices add a little, so allow a small margin over the raw budget.
    expect(after).toBeLessThan(INSTRUCTION_STACK_MAX_CHARS + 1_000);
    expect(result.trimmed.length + result.dropped.length).toBeGreaterThan(0);
  });
});
