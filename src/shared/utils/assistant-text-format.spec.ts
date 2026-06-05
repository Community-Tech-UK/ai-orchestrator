import { describe, expect, it } from 'vitest';
import {
  countNarrationMarkers,
  formatAssistantTextForDisplay,
  isNarrationHeavy,
  splitNarrationFromResponse,
} from './assistant-text-format';
import { extractThinkingContent } from './thinking-extractor';

describe('formatAssistantTextForDisplay', () => {
  it('inserts paragraph breaks before narration transitions', () => {
    const input =
      "I'll start by reading the plan. Now let me explore the codebase. Let me read usage-monitor-source.ts.";
    const formatted = formatAssistantTextForDisplay(input);

    expect(formatted).toContain("I'll start by reading the plan.\n\nNow let me explore");
    expect(formatted).toContain('codebase.\n\nLet me read');
  });

  it('inserts space after inline code glued to the next word', () => {
    expect(formatAssistantTextForDisplay('add imports to `default-invokers.ts`:Now wire')).toContain(
      '`default-invokers.ts`: Now',
    );
  });

  it('inserts space after punctuation glued to a capital letter', () => {
    expect(formatAssistantTextForDisplay('quota types:Now add throttle helpers')).toContain(
      'types: Now add',
    );
  });
});

describe('splitNarrationFromResponse', () => {
  it('splits planning narration from a trailing user-facing response', () => {
    const input = [
      "I'll start by reading usage-aware-throttling-plan.md.",
      'Now let me explore usage-monitor-source.ts.',
      'Let me read loop-coordinator.ts next.',
      '',
      '## Summary',
      '',
      'Implemented usage-aware throttling with reactive backstops.',
    ].join('\n');

    const split = splitNarrationFromResponse(input);
    expect(split).not.toBeNull();
    expect(split!.thinking).toContain('usage-aware-throttling-plan.md');
    expect(split!.response).toContain('## Summary');
  });

  it('treats narration-only walls as thinking when heavily marked', () => {
    const input = [
      "I'll start by reading the plan.",
      'Now let me explore the codebase.',
      'Let me read usage-monitor-source.ts.',
      'Now let me read loop-coordinator.ts.',
      "Now I'll add throttle helpers to runLoop.",
    ].join(' ');

    const split = splitNarrationFromResponse(input);
    expect(split).not.toBeNull();
    expect(split!.response).toBe('');
    expect(isNarrationHeavy(split!.thinking)).toBe(true);
    expect(countNarrationMarkers(split!.thinking)).toBeGreaterThanOrEqual(3);
  });

  it('does not split simple assistant replies', () => {
    expect(splitNarrationFromResponse('Hello world')).toBeNull();
  });
});

describe('extractThinkingContent narration extraction', () => {
  it('extracts Cursor-style planning monologue into thinking blocks', () => {
    const input = [
      "I'll start by reading usage-aware-throttling-plan.md.",
      'Now let me explore usage-monitor-source.ts.',
      'Let me read loop-coordinator.ts next.',
      "Now I'll add throttle helpers to runLoop.",
    ].join(' ');

    const result = extractThinkingContent(input);
    expect(result.hasThinking).toBe(true);
    expect(result.thinking[0].content).toContain('usage-aware-throttling-plan.md');
    expect(result.response.trim()).toBe('');
  });

  it('keeps short non-narration replies intact', () => {
    const result = extractThinkingContent('Hello world');
    expect(result.hasThinking).toBe(false);
    expect(result.response).toBe('Hello world');
  });
});
