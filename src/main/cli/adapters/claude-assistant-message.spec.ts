import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliStreamMessage } from '../../../shared/types/cli.types';
import type { Instance } from '../../../shared/types/instance.types';
import type { RawCliPayload } from './claude-cli-adapter.types';
import { processClaudeAssistantMessage, type ClaudeAssistantMessageHost } from './claude-assistant-message';
import { recordInstanceContextCall } from '../../context/instance-cache-usage';
import { CacheAnalyticsService } from '../../context/cache-analytics-service';

vi.mock('../../core/system/provider-quota-service', () => ({
  getProviderQuotaService: () => ({ getSnapshot: () => ({ plan: 'pro', windows: [] }) }),
}));
vi.mock('../../core/system/copilot-credit-recorder', () => ({
  getCopilotCreditRecorder: () => ({ getCopilotCacheState: () => [] }),
}));

const instance = { id: 'i1', provider: 'claude', currentModel: 'sonnet', accountProfileId: 'acct' } as Instance;

interface FrameUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

function frame(messageId: string | undefined, usage: FrameUsage): [CliStreamMessage, RawCliPayload] {
  const raw: RawCliPayload = {
    type: 'assistant',
    message: {
      ...(messageId !== undefined ? { id: messageId } : {}),
      content: [{ type: 'text', text: 'hello' }],
      usage,
    },
  };
  return [{ type: 'assistant', timestamp: 1_700_000_000_000 } as CliStreamMessage, raw];
}

function createHost(): { host: ClaudeAssistantMessageHost; contexts: Record<string, unknown>[] } {
  const contexts: Record<string, unknown>[] = [];
  const host: ClaudeAssistantMessageHost = {
    emit(event: string, ...args: unknown[]): boolean {
      if (event === 'context') {
        contexts.push(args[0] as Record<string, unknown>);
        recordInstanceContextCall(instance, args[0]);
      }
      return true;
    },
    rememberToolUse: () => undefined,
    emitAsyncWork: () => undefined,
    emitAskUserQuestionInputRequired: () => undefined,
    lastKnownContextWindow: 200_000,
    hasPerCallUsageThisTurn: false,
    lastObservedContextUsage: null,
  };
  return { host, contexts };
}

describe('claude per-call cache accounting across multi-frame calls', () => {
  beforeEach(() => {
    CacheAnalyticsService._resetForTesting();
  });

  it('charges a cache rewrite once per provider call, not once per assistant frame', () => {
    const { host, contexts } = createHost();
    const service = CacheAnalyticsService.getInstance();
    const cold = { input_tokens: 0, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 120_000 };
    const warmMiss = { input_tokens: 100_000, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

    processClaudeAssistantMessage(host, ...frame('msg_call_1', cold));

    // One provider call flushed as thinking, text and tool_use frames: same
    // message.id and same call usage on every frame.
    for (let i = 0; i < 3; i++) {
      processClaudeAssistantMessage(host, ...frame('msg_call_2', warmMiss));
    }

    expect(contexts).toHaveLength(4);
    for (const context of contexts) {
      expect(context).toMatchObject({ total: 200_000, mainThread: true });
    }
    expect(contexts.map(context => context['callId'])).toEqual(['msg_call_1', 'msg_call_2', 'msg_call_2', 'msg_call_2']);

    const report = service.getReport('i1');
    // The cold-cache call costs one 100K-token rewrite — not one per frame.
    expect(report.rewriteTokens).toBe(100_000);
    expect(report.samples).toHaveLength(2);
    expect(report.lastBreak).toMatchObject({ missedTokens: 100_000 });
  });

  it('still charges a later call with its own identity', () => {
    const { host } = createHost();
    const service = CacheAnalyticsService.getInstance();
    const cold = { input_tokens: 0, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 120_000 };
    const miss = { input_tokens: 80_000, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 20_000 };

    processClaudeAssistantMessage(host, ...frame('msg_a', cold));
    processClaudeAssistantMessage(host, ...frame('msg_b', miss));
    processClaudeAssistantMessage(host, ...frame('msg_c', miss));

    const report = service.getReport('i1');
    expect(report.rewriteTokens).toBe(160_000);
  });

  it('keeps per-frame accounting when frames carry no provider call identity', () => {
    const { host, contexts } = createHost();
    const service = CacheAnalyticsService.getInstance();
    const cold = { input_tokens: 0, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 120_000 };
    const warmMiss = { input_tokens: 100_000, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

    processClaudeAssistantMessage(host, ...frame(undefined, cold));
    processClaudeAssistantMessage(host, ...frame(undefined, warmMiss));
    processClaudeAssistantMessage(host, ...frame(undefined, warmMiss));

    expect(contexts).toHaveLength(3);
    for (const context of contexts) expect(context['callId']).toBeUndefined();
    // No identity to group on: every frame is accounted exactly as before.
    expect(service.getReport('i1').rewriteTokens).toBe(200_000);
  });

  it('keeps occupancy updates on every frame of one call', () => {
    const { host, contexts } = createHost();
    const usage = { input_tokens: 10_000, output_tokens: 5, cache_creation_input_tokens: 2_000, cache_read_input_tokens: 8_000 };
    for (let i = 0; i < 3; i++) {
      processClaudeAssistantMessage(host, ...frame('msg_occ', usage));
    }
    expect(contexts.map(context => context['used'])).toEqual([20_005, 20_005, 20_005]);
    expect(host.lastObservedContextUsage).toEqual({ used: 20_005, total: 200_000 });
    expect(host.hasPerCallUsageThisTurn).toBe(true);
  });
});
