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
});
