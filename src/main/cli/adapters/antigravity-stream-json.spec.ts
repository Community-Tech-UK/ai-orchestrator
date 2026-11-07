import { describe, expect, it } from 'vitest';

import { AntigravityStreamReader, antigravityUsageToCliUsage } from './antigravity-stream-json';

const line = (event: Record<string, unknown>): string => JSON.stringify(event);

describe('AntigravityStreamReader', () => {
  it('returns null for lines that are not agy events', () => {
    const reader = new AntigravityStreamReader();
    expect(reader.readLine('plain text')).toBeNull();
    expect(reader.readLine('[1,2]')).toBeNull();
    expect(reader.readLine(line({ other: true }))).toBeNull();
    expect(reader.readLine(line({ event: 'something_new' }))).toEqual([]);
  });

  it('marks the turn started on init and keeps the conversation id', () => {
    const reader = new AntigravityStreamReader();
    expect(reader.started).toBe(false);
    reader.readLine(line({ event: 'init', conversation_id: 'c-1', init: {} }));
    expect(reader.started).toBe(true);
    expect(reader.conversationId).toBe('c-1');
  });

  it('announces a tool once even when agy reports only its finished state', () => {
    const reader = new AntigravityStreamReader();
    const finished = line({ event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'list_dir', tool_info: { output: 'a\nb' } } });
    expect(reader.readLine(finished)?.map(message => message.type)).toEqual(['tool_use', 'tool_result']);
    expect(reader.readLine(finished)).toEqual([]);
  });

  it('knows when a tool is running', () => {
    const reader = new AntigravityStreamReader();
    const tool = (index: number, state: string): string => line({ event: 'step_update', step_update: { step_index: index, state, step_type: 'tool', tool_name: 'run_command' } });
    expect(reader.toolRunning()).toBe(false);
    reader.readLine(tool(2, 'ACTIVE'));
    reader.readLine(tool(2, 'ACTIVE'));
    expect(reader.toolRunning()).toBe(true);
    reader.readLine(tool(2, 'ERROR'));
    expect(reader.toolRunning()).toBe(false);
    reader.readLine(tool(3, 'DONE'));
    expect(reader.toolRunning()).toBe(false);
    reader.readLine(line({ event: 'step_update', step_update: { step_index: 4, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'x' } }));
    expect(reader.toolRunning()).toBe(false);
  });

  it('shortens long tool output', () => {
    const reader = new AntigravityStreamReader();
    const output = 'x'.repeat(5000);
    const [, toolResult] = reader.readLine(line({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'read_file', tool_info: { output } } }))!;
    expect(toolResult.content).toHaveLength(4000 + '\n… (1000 more characters)'.length);
    expect(toolResult.content.endsWith('\n… (1000 more characters)')).toBe(true);
  });

  it('keeps the result, including actions agy refused', () => {
    const reader = new AntigravityStreamReader();
    reader.readLine(line({ event: 'result', result: { status: 'SUCCESS', response: '', denied_actions: [{ action: 'read_file', display_name: 'ReadFile' }] } }));
    expect(reader.result).toEqual({ status: 'SUCCESS', response: '', deniedActions: ['read_file'] });
  });

  it('falls back to the streamed text, in step order, when the result has no response', () => {
    const reader = new AntigravityStreamReader();
    reader.readLine(line({ event: 'step_update', step_update: { step_index: 5, state: 'DONE', step_type: 'agent_response', text_delta: 'second' } }));
    reader.readLine(line({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'first' } }));
    expect(reader.responseText()).toBe('first\n\nsecond');
    expect(reader.unstreamedReply()).toBeNull();
  });
});

describe('antigravityUsageToCliUsage', () => {
  it('splits cache reads out of the input count, which already includes them', () => {
    expect(antigravityUsageToCliUsage({ input_tokens: 10_000, output_tokens: 300, cache_read_tokens: 6_000, total_tokens: 10_300 }))
      .toEqual({ inputTokens: 4_000, outputTokens: 300, cacheReadTokens: 6_000, totalTokens: 10_300 });
  });

  it('omits cache reads when there are none and fills a missing total', () => {
    expect(antigravityUsageToCliUsage({ input_tokens: 7_000, output_tokens: 150 }))
      .toEqual({ inputTokens: 7_000, outputTokens: 150, totalTokens: 7_150 });
  });
});
