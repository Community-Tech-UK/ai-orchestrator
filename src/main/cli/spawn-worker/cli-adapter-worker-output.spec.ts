import { describe, expect, it } from 'vitest';
import { parseWorkerOutput } from './cli-adapter-worker-output';

describe('Claude worker output parser', () => {
  it('keeps native zero output and separate cache counters', () => {
    const frames = [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Paid answer' }],
        usage: { input_tokens: 10, output_tokens: 5 } } },
      { type: 'result', subtype: 'error_during_execution', is_error: true,
        total_cost_usd: 0.25, usage: { input_tokens: 100, output_tokens: 0,
          cache_read_input_tokens: 40, cache_creation_input_tokens: 0 } },
    ];
    const response = parseWorkerOutput(frames.map(frame => JSON.stringify(frame)).join('\n'), 'claude', 'fixture');
    expect(response.usage).toMatchObject({ inputTokens: 100, outputTokens: 0,
      cacheReadTokens: 40, cacheWriteTokens: 0, providerSessionTotalUsd: 0.25 });
    expect(response.metadata).toMatchObject({ turnErrored: true });
  });
});
