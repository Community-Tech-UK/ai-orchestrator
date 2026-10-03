import { describe, expect, it } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import { buildProviderRuntimeEventIngress } from './instance-provider-event-ingress';

describe('interactive provider turn-ending ingress', () => {
  it('classifies the actual interactive completion seam and retains request fencing', () => {
    const instance = { id: 'fixture', provider: 'claude', adapterGeneration: 1 } as Instance;
    const publish = (event: Parameters<typeof buildProviderRuntimeEventIngress>[0]['event'], payload?: unknown) => buildProviderRuntimeEventIngress({
      getInstance: () => instance, instanceId: instance.id, event,
      ...(payload ? { options: { raw: { source: `adapter-event:${event.kind}`, payload } } } : {}),
    });
    publish({ kind: 'status', status: 'busy' });
    publish({ kind: 'output', content: '', messageType: 'assistant', thinking: [{ id: 't1', content: 'Hmm. '.repeat(40), format: 'sdk' }] });
    expect(publish({ kind: 'complete', requestCountAtCompletion: 7 }, { content: '', usage: { outputTokens: 0, reasoningTokens: 32004 } })?.event)
      .toMatchObject({ requestCountAtCompletion: 7, outputTokens: 0, reasoningTokens: 32004, turnEnding: { reason: 'max_output' } });
    publish({ kind: 'status', status: 'busy' });
    expect(publish({ kind: 'complete' }, { content: 'Ready.' })?.event).toMatchObject({ turnEnding: { reason: 'completed' } });
  });

  it('classifies native errors and isolates observations between adapter generations', () => {
    const instance = { id: 'fixture', provider: 'copilot', adapterGeneration: 1 } as Instance;
    const publish = (event: Parameters<typeof buildProviderRuntimeEventIngress>[0]['event']) => buildProviderRuntimeEventIngress({ getInstance: () => instance, instanceId: instance.id, event });
    expect(publish({ kind: 'error', message: 'ContentFilterError' })?.event).toMatchObject({ turnEnding: { reason: 'content_filter' } });
    publish({ kind: 'output', content: '', messageType: 'assistant', thinking: [{ id: 't1', content: 'Hmm. '.repeat(40), format: 'sdk' }] });
    instance.adapterGeneration = 2;
    expect(publish({ kind: 'complete' })?.event).toMatchObject({ turnEnding: { reason: 'completed' } });
  });

  it('preserves authoritative normalized endings when capture projections omit native fields', () => {
    const instance = { id: 'fixture', provider: 'claude', adapterGeneration: 1 } as Instance;
    const pending = buildProviderRuntimeEventIngress({ getInstance: () => instance, instanceId: instance.id,
      event: { kind: 'complete', turnEnding: { reason: 'max_output', evidence: 'native_max_output' } },
      options: { raw: { source: 'adapter-event:complete', payload: { content: '' } } },
    });
    expect(pending?.event).toMatchObject({ turnEnding: { reason: 'max_output' } });
  });

  it('retains native tool boundaries when capture projections omit their finish reason', () => {
    const instance = { id: 'fixture', provider: 'claude', adapterGeneration: 1 } as Instance;
    const publish = (event: Parameters<typeof buildProviderRuntimeEventIngress>[0]['event'], payload?: unknown) => buildProviderRuntimeEventIngress({
      getInstance: () => instance, instanceId: instance.id, event,
      options: { raw: { source: `adapter-event:${event.kind}`, payload } },
    });
    publish({ kind: 'tool_use', toolName: 'Read', toolUseId: 'read-1' });
    publish({ kind: 'tool_result', toolName: 'Read', toolUseId: 'read-1', success: true });
    expect(publish({ kind: 'complete', stopReason: 'tool_calls', turnEnding: { reason: 'completed', evidence: 'provider_tool_boundary', autoContinueSuppressed: true } }, { content: '' })?.event)
      .toMatchObject({ turnEnding: { reason: 'completed', autoContinueSuppressed: true } });
  });
});
