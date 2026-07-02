import { describe, expect, it } from 'vitest';
import { buildCompactionPrompt, extractBranchSummaryBlocks } from './context-compaction-prompt';
import type { FileOperation } from './file-operation-extractor';

describe('buildCompactionPrompt', () => {
  it('instructs the summarizer to preserve pending asks and remaining next step verbatim', () => {
    const prompt = buildCompactionPrompt(
      [
        'USER: Please fully implement the attached loop specs.',
        'ASSISTANT: Next I will update the typed pending-input schema.',
      ].join('\n'),
      null,
    );

    expect(prompt).toContain('## Pending User Asks');
    expect(prompt).toContain('## Remaining Work');
    expect(prompt).toMatch(/Pending User Asks[\s\S]*verbatim/i);
    expect(prompt).toMatch(/Remaining Work[\s\S]*verbatim/i);
    expect(prompt).toContain('next step');
  });

  it('keeps prior summaries anchored when provided', () => {
    const prompt = buildCompactionPrompt('new turn', 'old summary');

    expect(prompt).toContain('<prior_summary>');
    expect(prompt).toContain('old summary');
    expect(prompt).toContain('</prior_summary>');
  });

  it('places bounded file operations after relevant files when provided', () => {
    const operations: FileOperation[] = [
      { kind: 'edit', path: 'src/main/context/context-compactor.ts', source: 'tool-output' },
      { kind: 'write', path: 'docs/loop-notes.md', source: 'assistant-text' },
    ];
    const prompt = buildCompactionPrompt('new turn', null, operations);

    expect(prompt).toContain('## File Operations Observed');
    expect(prompt).toContain('- edit: src/main/context/context-compactor.ts (tool-output)');
    expect(prompt).toMatch(
      /## Relevant Files[\s\S]*## File Operations Observed[\s\S]*## Remaining Work/
    );
  });

  it('anchors branch-switch summaries with a preservation instruction when provided', () => {
    const block = [
      '<branch_switch_summary>',
      'from: thread-main',
      'to: thread-branch',
      'Implemented the parser on the main branch.',
      '</branch_switch_summary>',
    ].join('\n');

    const prompt = buildCompactionPrompt('new turn', null, [], [block]);

    expect(prompt).toContain('<branch_switch_summaries>');
    expect(prompt).toContain('Implemented the parser on the main branch.');
    expect(prompt).toContain('</branch_switch_summaries>');
    expect(prompt).toMatch(/branch_switch_summaries[\s\S]*Preserve their decisions, file paths, and unresolved work/);
  });

  it('omits the branch summary section when none are supplied', () => {
    expect(buildCompactionPrompt('new turn', null)).not.toContain('<branch_switch_summaries>');
    expect(buildCompactionPrompt('new turn', null, [], [])).not.toContain('<branch_switch_summaries>');
  });
});

describe('extractBranchSummaryBlocks', () => {
  const block = (label: string) =>
    `<branch_switch_summary>\n${label}\n</branch_switch_summary>`;

  it('takes whole turns flagged as branch-summary ledger events', () => {
    const blocks = extractBranchSummaryBlocks([
      { content: 'regular assistant turn' },
      { content: block('summary of main branch'), metadata: { kind: 'branch-summary' } },
    ]);

    expect(blocks).toEqual([block('summary of main branch')]);
  });

  it('extracts blocks embedded inside continuity preamble content', () => {
    const embedded = `Context rebuild preamble.\n\n${block('embedded branch context')}\n\nContinue.`;
    const blocks = extractBranchSummaryBlocks([{ content: embedded }]);

    expect(blocks).toEqual([block('embedded branch context')]);
  });

  it('returns an empty list when no branch summaries are present', () => {
    expect(extractBranchSummaryBlocks([{ content: 'user: hello' }, { content: 'assistant: hi' }])).toEqual([]);
  });

  it('keeps only the most recent blocks, oldest first, when over the cap', () => {
    const turns = ['one', 'two', 'three', 'four'].map((label) => ({
      content: block(label),
      metadata: { kind: 'branch-summary' },
    }));

    expect(extractBranchSummaryBlocks(turns)).toEqual([block('two'), block('three'), block('four')]);
  });
});
