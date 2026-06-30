import { describe, expect, it } from 'vitest';
import { buildCompactionPrompt } from './context-compaction-prompt';

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
});
