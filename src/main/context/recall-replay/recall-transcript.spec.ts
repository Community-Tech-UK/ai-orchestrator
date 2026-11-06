import { describe, expect, it } from 'vitest';
import {
  analyseTranscript,
  contextPoints,
  conversationSegments,
  humanPromptCount,
  lineAtContext,
  renderExcerpt,
} from './recall-transcript';

// Synthetic transcripts only: nothing here is real conversation text.
const usage = (context: number) => ({ input_tokens: 10, cache_creation_input_tokens: 40, cache_read_input_tokens: context - 50, output_tokens: 5 });
const assistant = (id: string, context: number, over: Record<string, unknown> = {}, content: unknown[] = [{ type: 'text', text: `reply ${id}` }], stop: string | null = 'end_turn'): string =>
  JSON.stringify({ type: 'assistant', isSidechain: false, message: { id, role: 'assistant', content, stop_reason: stop, usage: usage(context) }, ...over });
const human = (text: string): string => JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: text } });
const toolResult = (text: string): string => JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: text }] } });

describe('contextPoints', () => {
  it('measures one point per assistant message from input plus both cache counts, last record winning the line', () => {
    const lines = [human('hi'), assistant('m1', 1000, {}, [{ type: 'thinking', thinking: 'x' }], null), assistant('m1', 1000), human('more'), assistant('m2', 2500)];
    expect(contextPoints(lines)).toEqual([
      { messageId: 'm1', lineIndex: 2, contextTokens: 1000, endTurn: true },
      { messageId: 'm2', lineIndex: 4, contextTokens: 2500, endTurn: true },
    ]);
  });

  it('ignores helper-agent records, unparseable lines and records without usage, and marks tool-use stops as not final', () => {
    const lines = ['{broken', assistant('side', 9999, { isSidechain: true }), JSON.stringify({ type: 'assistant', message: { id: 'nou', stop_reason: 'end_turn' } }),
      assistant('tool', 800, {}, [{ type: 'tool_use', id: 'u', name: 'Read', input: {} }], 'tool_use')];
    expect(contextPoints(lines)).toEqual([{ messageId: 'tool', lineIndex: 3, contextTokens: 800, endTurn: false }]);
  });
});

describe('analyseTranscript', () => {
  const build = (contexts: number[], extra: string[] = []): string[] => [
    ...Array.from({ length: 25 }, (_, index) => human(`prompt ${index}`)),
    ...contexts.map((context, index) => assistant(`m${index}`, context)),
    ...extra,
  ];

  it('cuts at the last final answer at or below the target and counts earlier human prompts', () => {
    const lines = build([100_000, 250_000, 290_000, 310_000]);
    const result = analyseTranscript(lines, 300_000, 0.15);
    expect(result).toMatchObject({ contextTokens: 290_000, humanPrompts: 25, priorBoundaries: 0 });
    expect(lines[result!.cutLine]).toContain('"id":"m2"');
  });

  it('declines when nothing final lands within the tolerance below the target', () => {
    expect(analyseTranscript(build([100_000, 200_000, 400_000]), 300_000, 0.15)).toBeNull();
    expect(analyseTranscript(build([290_000]).map(line => line.replace('"end_turn"', '"tool_use"')), 300_000, 0.15)).toBeNull();
  });

  it('reports a compaction that happened before the cut so such chats can be skipped', () => {
    const boundary = JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { preTokens: 5, postTokens: 1 } });
    const lines = [...build([100_000]), boundary, assistant('late', 290_000)];
    expect(analyseTranscript(lines, 300_000, 0.15)).toMatchObject({ priorBoundaries: 1 });
  });
});

describe('humanPromptCount', () => {
  it('counts typed prompts only, not tool results, meta or compaction summaries', () => {
    const lines = [human('a'), toolResult('out'), JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: 'meta' } }),
      JSON.stringify({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'summary' } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'typed as blocks' }] } }), human('b')];
    expect(humanPromptCount(lines, lines.length - 1)).toBe(3);
    expect(humanPromptCount(lines, 0)).toBe(1);
  });
});

describe('excerpts', () => {
  const lines = [
    human('Please rename the widget in src/ui/panel.ts'),
    assistant('m0', 5_000, {}, [{ type: 'thinking', thinking: 'private reasoning' }, { type: 'text', text: 'Renaming it now.' },
      { type: 'tool_use', id: 'u1', name: 'Edit', input: { file_path: 'src/ui/panel.ts', old_string: 'x'.repeat(500), new_string: 'y' } }], 'tool_use'),
    toolResult('r'.repeat(900)),
    assistant('m1', 6_000, {}, [{ type: 'text', text: 'Done. The widget is now called Gadget.' }]),
    assistant('m2', 120_000),
  ];

  it('keeps typed text, answers and short tool summaries, and drops reasoning and long tool bodies', () => {
    const segments = conversationSegments(lines, lines.length - 1);
    const joined = segments.map(item => item.text).join('\n');
    expect(joined).toContain('Please rename the widget');
    expect(joined).toContain('Done. The widget is now called Gadget.');
    expect(joined).toContain('Edit(src/ui/panel.ts)');
    expect(joined).not.toContain('private reasoning');
    expect(joined).not.toContain('x'.repeat(100));
    expect(segments.find(item => item.role === 'tool-result')!.text.length).toBeLessThanOrEqual(420);
  });

  it('finds the line where the context first reaches a size, and renders within a character budget', () => {
    const points = contextPoints(lines);
    expect(lineAtContext(points, 5_500)).toBe(3);
    expect(lineAtContext(points, 1)).toBe(1);
    expect(lineAtContext(points, 999_999)).toBe(points.at(-1)!.lineIndex);
    const rendered = renderExcerpt(conversationSegments(lines, 3), 120);
    expect(rendered.length).toBeLessThanOrEqual(120);
    expect(rendered.startsWith('USER:')).toBe(true);
  });
});
