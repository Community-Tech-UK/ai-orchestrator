import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { sendRecordedOrchestrationCall } from './orchestration-call-recording';
import { deferResponseUsage } from '../cli/adapters/deferred-response-usage';
import type { CliResponse } from '../cli/adapters/base-cli-adapter';
const record = vi.hoisted(() => vi.fn());
vi.mock('../core/system/model-call-recorder', () => ({ recordModelCall: record }));
describe('deferred loop call accounting', () => {
  it('records the settled four-category usage once and returns the semantic response so cleanup can drive settlement', async () => {
    record.mockClear();
    const response: CliResponse = { id: 'turn', role: 'assistant', content: 'checked' };
    const settle = deferResponseUsage(response);
    expect(await sendRecordedOrchestrationCall(new EventEmitter(), { taskType: 'loop-orchestration:claude', correlationId: 'loop::1', provider: 'claude' }, async () => response)).toBe(response);
    expect(record).not.toHaveBeenCalled();
    response.usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 20, cacheWriteTokens: 30 };
    settle(); settle();
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0][0].usage).toMatchObject(response.usage);
  });
});
