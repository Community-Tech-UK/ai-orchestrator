import { describe, it, expectTypeOf } from 'vitest';
import type {
  ProviderRuntimeEventEnvelope,
  ProviderName,
  ProviderOutputEvent,
} from '@contracts/types/provider-runtime-events';

describe('ProviderRuntimeEventEnvelope shape', () => {
  it('has eventId, seq, numeric timestamp, and typed provider', () => {
    const env: ProviderRuntimeEventEnvelope = {
      eventId: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789',
      seq: 0,
      timestamp: 1713340800000,
      provider: 'claude',
      instanceId: 'i-1',
      event: { kind: 'status', status: 'busy' },
    };
    expectTypeOf(env.eventId).toEqualTypeOf<string>();
    expectTypeOf(env.seq).toEqualTypeOf<number>();
    expectTypeOf(env.timestamp).toEqualTypeOf<number>();
    expectTypeOf(env.provider).toEqualTypeOf<ProviderName>();
  });

  it('supports rich output payloads', () => {
    const output: ProviderOutputEvent = {
      kind: 'output',
      content: '',
      messageType: 'assistant',
      messageId: 'msg-1',
      timestamp: 1713340800123,
      metadata: { foo: 1 },
      attachments: [{ name: 'diagram.png', type: 'image/png', size: 4, data: 'abcd' }],
      thinking: [{ id: 'thinking-1', content: 'Inspect first', format: 'structured', tokenCount: 12 }],
      thinkingExtracted: true,
    };

    expectTypeOf(output.messageId).toEqualTypeOf<string | undefined>();
    expectTypeOf(output.timestamp).toEqualTypeOf<number | undefined>();
    expectTypeOf(output.attachments).toEqualTypeOf<
      { name: string; type: string; size: number; data: string }[] | undefined
    >();
    expectTypeOf(output.thinking).toEqualTypeOf<
      {
        id: string;
        content: string;
        format: 'structured' | 'xml' | 'bracket' | 'header' | 'sdk' | 'unknown';
        timestamp?: number;
        tokenCount?: number;
      }[] | undefined
    >();
    expectTypeOf(output.thinkingExtracted).toEqualTypeOf<boolean | undefined>();
  });
});
