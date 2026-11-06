import { describe, expect, it, vi } from 'vitest';
import type { CliStreamMessage } from '../../../shared/types/cli.types';
import { processClaudeAssistantMessage, type ClaudeAssistantMessageHost } from './claude-assistant-message';
import type { RawCliPayload } from './claude-cli-adapter.types';

function makeHost(): ClaudeAssistantMessageHost & { emitted: [string, unknown][] } {
  const emitted: [string, unknown][] = [];
  return {
    emitted,
    emit: vi.fn((event: string, payload?: unknown) => { emitted.push([event, payload]); return true; }),
    rememberToolUse: vi.fn(),
    emitAsyncWork: vi.fn(),
    emitAskUserQuestionInputRequired: vi.fn(),
    lastKnownContextWindow: 1_000_000,
    hasPerCallUsageThisTurn: false,
    lastObservedContextUsage: null,
  };
}

const frame = (inputTokens: number, parent?: string): RawCliPayload => ({
  type: 'assistant',
  ...(parent ? { parent_tool_use_id: parent } : {}),
  message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: inputTokens, output_tokens: 10, cache_read_input_tokens: 0 } },
});
const run = (host: ClaudeAssistantMessageHost, raw: RawCliPayload): void =>
  processClaudeAssistantMessage(host, raw as unknown as CliStreamMessage, raw);

describe('helper frames and the main thread context', () => {
  it('does not replace main-thread occupancy with a helper request size', () => {
    const host = makeHost();
    run(host, frame(210_000));
    run(host, frame(12_000, 'toolu_helper'));
    expect(host.lastObservedContextUsage).toEqual({ used: 210_010, total: 1_000_000 });
    const contexts = host.emitted.filter(([event]) => event === 'context').map(([, payload]) => (payload as { used: number }).used);
    expect(contexts).toEqual([210_010]);
  });

  it('still shows the helper as activity', () => {
    const host = makeHost();
    run(host, frame(12_000, 'toolu_helper'));
    expect(host.emitted.map(([event]) => event)).toContain('status');
    expect(host.emitted.map(([event]) => event)).toContain('output');
    expect(host.hasPerCallUsageThisTurn).toBe(false);
  });
});
