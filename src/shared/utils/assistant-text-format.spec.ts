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

  it('leaves an ordered-list item that opens with a narration word alone', () => {
    // Regression: Codex emitted `5. Once Worker → … click **Enrol target**.`
    // and the narration rule rewrote the marker to `5.\n\nOnce …`. That closed
    // the list at an empty item 5 and left `6.` rendering as literal text.
    const input = [
      '4. Click **Validate endpoint**.',
      '5. Once Worker → Endpoint → Model → Canary all pass, click **Enrol target**.',
      '6. The status should move through checking to healthy.',
    ].join('\n');

    expect(formatAssistantTextForDisplay(input)).toBe(input);
  });

  it('leaves indented and multi-digit ordered-list markers alone', () => {
    const input = ['  3. Next, restart the worker.', '  12. Then confirm it is healthy.'].join('\n');

    expect(formatAssistantTextForDisplay(input)).toBe(input);
  });

  it('never inserts a paragraph break across a newline', () => {
    // A lazy continuation line must stay inside its list item.
    const input = ['1. Enrol the target.', '   Once that lands, restart the worker.'].join('\n');

    expect(formatAssistantTextForDisplay(input)).toBe(input);
  });

  it('still breaks a mid-line sentence end that is not a list marker', () => {
    expect(formatAssistantTextForDisplay('Ran step 5. Once that lands, restart.')).toBe(
      'Ran step 5.\n\nOnce that lands, restart.',
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

  it('keeps a substantive answer that contains a lone reflective phrase', () => {
    // Regression: a real Codex answer with a single "I should" was scored as
    // narration-heavy and swallowed whole (empty response), which froze the
    // streamed bubble at the prefix "...It also means I".
    const input = [
      'That changes the interpretation materially.',
      '',
      'If Anthony did not write this plugin and plans to replace it, then the current MySQL connector does not prove anything about his proposed S2 architecture. At most, it proves the disposable S2 prototype currently supports MySQL.',
      '',
      'It also means I should narrow one part of my previous conclusion: the unsafe caching demonstrates the current S2 code is not multi-instance-safe, but it does not prove his future rewrite would have those faults.',
      '',
      'That is the crux. You do not need to accuse him of doing nothing. Ask him to identify the work he says exists.',
    ].join('\n');

    expect(isNarrationHeavy(input)).toBe(false);
    expect(splitNarrationFromResponse(input)).toBeNull();
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

  it('does not swallow a long answer that reflects with a single "I should"', () => {
    // End-to-end guard for the streaming freeze: extractThinkingContent runs on
    // every Codex delta, and an empty response collapses the visible message.
    const input = [
      'That changes the interpretation materially.',
      '',
      'If Anthony did not write this plugin and plans to replace it, then the current MySQL connector does not prove anything about his proposed S2 architecture.',
      '',
      'It also means I should narrow one part of my previous conclusion, but the rest of the analysis stands and the question for him is unchanged.',
    ].join('\n');

    const result = extractThinkingContent(input);
    expect(result.hasThinking).toBe(false);
    expect(result.response).toContain('That changes the interpretation materially.');
    expect(result.response).toContain('It also means I should narrow');
  });

  it('preserves an ordered list through the Codex final-message path', () => {
    // codex-app-server-turn-adapter emits `extracted.response` as the persisted
    // message content, and extractThinkingContent formats unconditionally —
    // so a narration rewrite here reaches conversation history, not just the UI.
    const input = [
      'What to do:',
      '',
      '1. Click **Configure windows-pc · ollama**.',
      '2. Choose the model(s) and canary model.',
      '3. Select at least one routing role.',
      '4. Click **Validate endpoint**.',
      '5. Once Worker → Endpoint → Model → Canary all pass, click **Enrol target**.',
      '6. The status should move through checking to healthy.',
    ].join('\n');

    const result = extractThinkingContent(input, { headerStyle: false });
    expect(result.hasThinking).toBe(false);
    expect(result.response).toBe(input);
  });
});
