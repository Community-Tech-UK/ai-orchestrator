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
const maxCatalogModelId = `${'m'.repeat(509)}-v1`;
const tooLongCatalogModelId = `${'m'.repeat(510)}-v1`;

describe('ProviderRuntimeEventEnvelopeSchema', () => {
  it('parses a valid envelope', () => {
    expect(() => ProviderRuntimeEventEnvelopeSchema.parse(baseEnv)).not.toThrow();
  });

  it('accepts an additive JSON-safe raw provider payload', () => {
    const parsed = ProviderRuntimeEventEnvelopeSchema.parse({
      ...baseEnv,
      raw: {
        source: 'adapter-event:output',
        payload: {
          id: 'native-message-1',
          content: 'hello',
          nested: [1, true, null],
        },
      },
    });

    expect(parsed.raw).toEqual({
      source: 'adapter-event:output',
      payload: {
        id: 'native-message-1',
        content: 'hello',
        nested: [1, true, null],
      },
    });
  });

  it('accepts envelope model ids up to the dynamic catalog limit', () => {
    expect(maxCatalogModelId).toHaveLength(512);

    const parsed = ProviderRuntimeEventEnvelopeSchema.parse({
      ...baseEnv,
      model: maxCatalogModelId,
    });

    expect(parsed.model).toBe(maxCatalogModelId);
  });

  it('rejects envelope model ids beyond the dynamic catalog limit', () => {
    expect(tooLongCatalogModelId).toHaveLength(513);

    expect(ProviderRuntimeEventEnvelopeSchema.safeParse({
      ...baseEnv,
      model: tooLongCatalogModelId,
    }).success).toBe(false);
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

  it('parses namespaced plugin provider envelopes', () => {
    expect(() =>
      ProviderRuntimeEventEnvelopeSchema.parse({
        ...baseEnv,
        provider: 'plugin:acme-cli',
      })
    ).not.toThrow();
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

  it('accepts each of the original 9 event kinds (WS-B10 additions covered separately below)', () => {
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

    // A3: degradedReason is an additive optional field on complete events.
    const degradedEvent = ProviderRuntimeEventEnvelopeSchema.parse({
        ...baseEnv,
        event: { kind: 'complete', degradedReason: 'partial-replay' },
      }).event;
    expect(degradedEvent).toMatchObject({ kind: 'complete', degradedReason: 'partial-replay' });

    // An unknown degraded reason is rejected by the enum.
    expect(() =>
      ProviderRuntimeEventEnvelopeSchema.parse({
        ...baseEnv,
        event: { kind: 'complete', degradedReason: 'made-up' },
      }),
    ).toThrow();

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

  it('accepts the remote pid sentinel (-1) and a real pid (0) on spawned events', () => {
    // Remote instances have no local pid; RemoteCliAdapter.spawn() emits -1.
    for (const pid of [-1, 0, 4321]) {
      expect(
        ProviderRuntimeEventEnvelopeSchema.safeParse({
          ...baseEnv,
          event: { kind: 'spawned', pid },
        }).success,
      ).toBe(true);
    }
  });

  it('rejects spawned pids below the sentinel or non-integer', () => {
    for (const pid of [-2, -5, 1.5]) {
      expect(
        ProviderRuntimeEventEnvelopeSchema.safeParse({
          ...baseEnv,
          event: { kind: 'spawned', pid },
        }).success,
      ).toBe(false);
    }
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

  // ── WS-B10: taxonomy hardening ──────────────────────────────────────────

  it('accepts the WS-B10 unknown event with a JSON-safe payload', () => {
    const parsed = ProviderRuntimeEventEnvelopeSchema.parse({
      ...baseEnv,
      event: {
        kind: 'unknown',
        providerRef: 'claude',
        rawType: 'output',
        payload: { odd: true, nested: [1, 2] },
        receivedAt: 1713340800000,
      },
    }).event;

    expect(parsed).toMatchObject({ kind: 'unknown', rawType: 'output' });
  });

  it('accepts an unknown event without the optional providerRef', () => {
    expect(() =>
      ProviderRuntimeEventEnvelopeSchema.parse({
        ...baseEnv,
        event: { kind: 'unknown', rawType: 'context', payload: null, receivedAt: 1 },
      })
    ).not.toThrow();
  });

  it('rejects an unknown event missing rawType or receivedAt', () => {
    expect(
      ProviderRuntimeEventEnvelopeSchema.safeParse({
        ...baseEnv,
        event: { kind: 'unknown', payload: null },
      }).success,
    ).toBe(false);
  });

  it('accepts tool_use_observed and tool_result_observed events', () => {
    const toolUseObserved = ProviderRuntimeEventEnvelopeSchema.parse({
      ...baseEnv,
      event: {
        kind: 'tool_use_observed',
        toolName: 'Read',
        callId: 'tool-1',
        argsHash: 'abc123',
        argsSummary: '{"path":"README.md"}',
      },
    }).event;
    expect(toolUseObserved).toMatchObject({ kind: 'tool_use_observed', toolName: 'Read', callId: 'tool-1' });

    const toolResultObserved = ProviderRuntimeEventEnvelopeSchema.parse({
      ...baseEnv,
      event: {
        kind: 'tool_result_observed',
        callId: 'tool-1',
        resultHash: 'def456',
        resultSummary: 'ok',
        isError: false,
      },
    }).event;
    expect(toolResultObserved).toMatchObject({ kind: 'tool_result_observed', resultSummary: 'ok', isError: false });
  });

  it('rejects tool_use_observed missing the required argsSummary', () => {
    expect(
      ProviderRuntimeEventEnvelopeSchema.safeParse({
        ...baseEnv,
        event: { kind: 'tool_use_observed', toolName: 'Read' },
      }).success,
    ).toBe(false);
  });

  it('accepts an envelope-level ephemeral marker', () => {
    const parsed = ProviderRuntimeEventEnvelopeSchema.parse({ ...baseEnv, ephemeral: true });
    expect(parsed.ephemeral).toBe(true);
  });
});

/**
 * LT-018. `ProviderContextEvent` carries `occupancyReported` so the diagnostics
 * panel — which renders this event rather than the instance's `contextUsage` —
 * can tell a real measurement from a "no reading yet" signal. A plain
 * `z.object()` strips unrecognised keys, so if the schema and the type drift
 * apart the flag is silently dropped from every persisted ledger row, and a real
 * measurement reads back as unreported.
 */
describe('ProviderContextEvent occupancyReported (LT-018)', () => {
  function parseContext(event: Record<string, unknown>) {
    return ProviderRuntimeEventEnvelopeSchema.parse({ ...baseEnv, event }) as {
      event: { occupancyReported?: boolean };
    };
  }

  it('round-trips occupancyReported: true rather than stripping it', () => {
    const parsed = parseContext({
      kind: 'context', used: 124_000, total: 200_000, occupancyReported: true,
    });
    expect(parsed.event.occupancyReported).toBe(true);
  });

  it('round-trips occupancyReported: false, which is not the same as absent', () => {
    const parsed = parseContext({
      kind: 'context', used: 0, total: 200_000, occupancyReported: false,
    });
    expect(parsed.event.occupancyReported).toBe(false);
  });

  it('stays optional, so pre-flag events still parse', () => {
    const parsed = parseContext({ kind: 'context', used: 10, total: 200 });
    expect(parsed.event.occupancyReported).toBeUndefined();
  });
});
