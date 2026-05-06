import { describe, it, expect } from 'vitest';
import { ProviderRuntimeEventEnvelopeSchema } from '@contracts/schemas/provider-runtime-events';

const baseEnv = {
  eventId: 'a1b2c3d4-e5f6-4890-abcd-ef0123456789',
  seq: 0,
  timestamp: 1713340800000,
  provider: 'claude' as const,
  instanceId: 'inst-1',
  event: { kind: 'status', status: 'busy' },
};

describe('ProviderRuntimeEventEnvelopeSchema', () => {
  it('parses a valid envelope', () => {
    expect(() => ProviderRuntimeEventEnvelopeSchema.parse(baseEnv)).not.toThrow();
  });

  it('parses a rich output event with attachments and thinking', () => {
    expect(() =>
      ProviderRuntimeEventEnvelopeSchema.parse({
        ...baseEnv,
        event: {
          kind: 'output',
          content: '',
          messageType: 'assistant',
          messageId: 'msg-1',
          timestamp: 1713340800123,
          metadata: { foo: 1 },
          attachments: [
            {
              name: 'diagram.png',
              type: 'image/png',
              size: 4,
              data: 'abcd',
            },
          ],
          thinking: [
            {
              id: 'thinking-1',
              content: 'Need to inspect the code path first',
              format: 'structured',
              tokenCount: 12,
            },
          ],
          thinkingExtracted: true,
        },
      })
    ).not.toThrow();
  });

  it('rejects a non-UUID eventId', () => {
    expect(() => ProviderRuntimeEventEnvelopeSchema.parse({ ...baseEnv, eventId: 'not-a-uuid' })).toThrow();
  });

  it('rejects a negative seq', () => {
    expect(() => ProviderRuntimeEventEnvelopeSchema.parse({ ...baseEnv, seq: -1 })).toThrow();
  });

  it('rejects an unknown provider', () => {
    expect(() => ProviderRuntimeEventEnvelopeSchema.parse({ ...baseEnv, provider: 'ollama' })).toThrow();
  });

  it('rejects an unknown event.kind', () => {
    expect(() =>
      ProviderRuntimeEventEnvelopeSchema.parse({ ...baseEnv, event: { kind: 'nope' } })
    ).toThrow();
  });

  it('rejects a string timestamp (old shape)', () => {
    expect(() =>
      ProviderRuntimeEventEnvelopeSchema.parse({ ...baseEnv, timestamp: '2026-04-17T00:00:00Z' })
    ).toThrow();
  });

  it('accepts each of the 9 event kinds', () => {
    const kinds = [
      { kind: 'output', content: 'hi' },
      { kind: 'tool_use', toolName: 'bash' },
      { kind: 'tool_result', toolName: 'bash', success: true },
      { kind: 'status', status: 'busy' },
      { kind: 'context', used: 10, total: 200 },
      { kind: 'error', message: 'oops' },
      { kind: 'exit', code: 0, signal: null },
      { kind: 'spawned', pid: 1234 },
      { kind: 'complete' },
    ] as const;
    for (const event of kinds) {
      expect(() =>
        ProviderRuntimeEventEnvelopeSchema.parse({ ...baseEnv, event })
      ).not.toThrow();
    }
  });

  it('accepts additive diagnostics on existing error, complete, and context events', () => {
    const errorEvent = ProviderRuntimeEventEnvelopeSchema.parse({
        ...baseEnv,
        event: {
          kind: 'error',
          message: 'Rate limited',
          requestId: 'req_123',
          rateLimit: { remaining: 0, resetAt: 1713340860000 },
        },
      }).event;
    expect(errorEvent).toMatchObject({
      kind: 'error',
      requestId: 'req_123',
      rateLimit: { remaining: 0, resetAt: 1713340860000 },
    });

    const completeEvent = ProviderRuntimeEventEnvelopeSchema.parse({
        ...baseEnv,
        event: {
          kind: 'complete',
          tokensUsed: 100,
          stopReason: 'end_turn',
          quota: { exhausted: false },
        },
      }).event;
    expect(completeEvent).toMatchObject({
      kind: 'complete',
      stopReason: 'end_turn',
      quota: { exhausted: false },
    });

    const contextEvent = ProviderRuntimeEventEnvelopeSchema.parse({
        ...baseEnv,
        event: {
          kind: 'context',
          used: 80,
          total: 100,
          percentage: 80,
          inputTokens: 55,
          outputTokens: 25,
          source: 'provider-usage',
          promptWeight: 0.68,
          promptWeightBreakdown: {
            systemPrompt: 20,
            mcpToolDescriptions: 10,
            skills: 5,
            userPrompt: 20,
          },
        },
      }).event;
    expect(contextEvent).toMatchObject({
      kind: 'context',
      inputTokens: 55,
      outputTokens: 25,
      source: 'provider-usage',
      promptWeight: 0.68,
      promptWeightBreakdown: {
        systemPrompt: 20,
        mcpToolDescriptions: 10,
        skills: 5,
        userPrompt: 20,
      },
    });
  });

  it('keeps the provider runtime kind freeze by rejecting api_diagnostics', () => {
    expect(() =>
      ProviderRuntimeEventEnvelopeSchema.parse({
        ...baseEnv,
        event: {
          kind: 'api_diagnostics',
          requestId: 'req_123',
        },
      })
    ).toThrow();
  });
});
