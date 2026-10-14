import { describe, expect, it, vi } from 'vitest';
import { parseClaudeSelfWakeup, sanitizeClaudeSelfWakeupRawNdjson } from './claude-cli-self-wakeup';
import { ClaudeCliAdapter } from './claude-cli-adapter';

vi.mock('../../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));

describe('Claude self-wakeup parser', () => {
  it('parses delay, bounded reason and due time without the prompt', () => {
    expect(parseClaudeSelfWakeup('ScheduleWakeup', 'stub-tool', { delaySeconds: 90, reason: 'x'.repeat(150), prompt: 'PRIVATE_PROMPT_PLACEHOLDER' }, 1000))
      .toEqual({ kind: 'requested', toolUseId: 'stub-tool', requestedAt: 1000, delaySeconds: 90, dueAt: 91_000, reason: 'x'.repeat(120) });
  });
  it('recognises stop and ignores refused/noop or unknown tools', () => {
    expect(parseClaudeSelfWakeup('ScheduleWakeup', 'stub', { stop: true }, 1)?.kind).toBe('stopped');
    expect(parseClaudeSelfWakeup('ScheduleWakeup', 'stub', { noop: true, delaySeconds: 90 }, 1)).toBeNull();
    expect(parseClaudeSelfWakeup('Other', 'stub', { delaySeconds: 90 }, 1)).toBeNull();
  });
  it.each([{}, { delaySeconds: -1 }, { delaySeconds: Number.NaN }, { delaySeconds: '90' }])('ignores invalid requests %j', input => {
    expect(parseClaudeSelfWakeup('ScheduleWakeup', 'stub', input, 1)).toBeNull();
  });
});

describe('Claude adapter wakeup ingress', () => {
  it.each(['assistant', 'tool_use'])('shows the asked notice and event from %s without any prompt', shape => {
    const adapter = new ClaudeCliAdapter();
    const output = vi.fn(); const event = vi.fn();
    adapter.on('output', output); adapter.on('self_wakeup', event);
    const tool = { id: 'stub-wakeup', name: 'ScheduleWakeup', input: { delaySeconds: 90, prompt: 'PRIVATE_PROMPT_PLACEHOLDER', reason: 'check later' } };
    const feed = (message: unknown) => (adapter as unknown as { processCliMessage(message: unknown): void }).processCliMessage(message);
    feed(shape === 'assistant' ? { type: 'assistant', message: { content: [{ ...tool, type: 'tool_use' }] } } : { type: 'tool_use', tool });
    expect(event).toHaveBeenCalledOnce();
    expect(output).toHaveBeenCalledWith(expect.objectContaining({ type: 'system', content: expect.stringContaining('Claude asked to be woken at') }));
    expect(JSON.stringify(output.mock.calls)).not.toContain('PRIVATE_PROMPT_PLACEHOLDER');
    expect(JSON.stringify(event.mock.calls)).not.toContain('PRIVATE_PROMPT_PLACEHOLDER');
  });
});


describe('self-wakeup output dedup and refusal', () => {
  it('does not repeat the notice when the same tool block is replayed', () => {
    const adapter = new ClaudeCliAdapter(); const output = vi.fn(); const event = vi.fn();
    adapter.on('output', output); adapter.on('self_wakeup', event);
    const feed = (message: unknown) => (adapter as unknown as { processCliMessage(message: unknown): void }).processCliMessage(message);
    const tool = { id: 'stub-repeat', name: 'ScheduleWakeup', input: { delaySeconds: 90 } };
    feed({ type: 'tool_use', tool }); feed({ type: 'tool_use', tool });
    expect(event).toHaveBeenCalledOnce();
    expect(output.mock.calls.filter(([message]) => message.type === 'system')).toHaveLength(1);
    feed({ type: 'tool_result', tool_use_id: tool.id, is_error: true, content: 'stub refusal' });
    expect(event).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'refused', toolUseId: tool.id }));
  });
});


describe('self-wakeup completion capture privacy', () => {
  it('omits the private prompt from parsed tool arguments and raw complete capture, retaining unrelated fields', () => {
    const adapter = new ClaudeCliAdapter();
    const assistant = { type: 'assistant', session_id: 'stub-session', message: { content: [
      { type: 'tool_use', id: 'stub-wakeup', name: 'ScheduleWakeup', input: { delaySeconds: 90, prompt: 'PRIVATE_PROMPT_PLACEHOLDER', reason: 'stub reason', stop: false, noop: false } },
      { type: 'tool_use', id: 'stub-other', name: 'OtherTool', input: { prompt: 'UNRELATED_PROMPT_PLACEHOLDER' } },
    ] } };
    const result = { type: 'result', usage: { input_tokens: 12, output_tokens: 3 }, total_cost_usd: 0.2 };
    const raw = `${JSON.stringify(assistant)}\n${JSON.stringify(result)}\n`;
    const response = adapter.parseOutput(raw);
    expect(JSON.stringify(response)).not.toContain('PRIVATE_PROMPT_PLACEHOLDER');
    expect(response.toolCalls?.[0].arguments).toEqual({ delaySeconds: 90, reason: 'stub reason', stop: false, noop: false });
    const sanitized = JSON.parse((response.raw as string).split('\n')[0]);
    expect(sanitized.message.content[1]).toEqual(assistant.message.content[1]);
    expect(sanitized.session_id).toBe('stub-session');
    expect((response.raw as string).split('\n')[1]).toBe(JSON.stringify(result));
    expect(response.usage).toMatchObject({ inputTokens: 12, outputTokens: 3, cost: 0.2 });
  });
  it('handles top-level tool messages and drops unparseable wakeup captures without changing other raw lines', () => {
    const line = { type: 'tool_use', tool: { name: 'ScheduleWakeup', input: { prompt: 'PRIVATE_PROMPT_PLACEHOLDER', delaySeconds: 90, extra: 'keep' } } };
    const cleaned = JSON.parse(sanitizeClaudeSelfWakeupRawNdjson(JSON.stringify(line)));
    expect(cleaned.tool.input).toEqual({ delaySeconds: 90, extra: 'keep' });
    expect(sanitizeClaudeSelfWakeupRawNdjson('ordinary line\r\n')).toBe('ordinary line\r\n');
    expect(sanitizeClaudeSelfWakeupRawNdjson('ScheduleWakeup PRIVATE_PROMPT_PLACEHOLDER')).not.toContain('PRIVATE_PROMPT_PLACEHOLDER');
  });
});
