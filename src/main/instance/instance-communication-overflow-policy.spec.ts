import { describe, expect, it, vi } from 'vitest';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import type { Instance } from '../../shared/types/instance.types';
import { InstanceCommunicationOverflowTracker } from './instance-communication-overflow-tracker';
import {
  OVERFLOW_DELEGATION_GUIDANCE,
  buildOverflowRetryMessage,
  InstanceCommunicationOverflowPolicy,
} from './instance-communication-overflow-policy';

function createInstance(): Instance {
  return {
    id: 'inst-1',
    status: 'busy',
    outputBuffer: [],
  } as unknown as Instance;
}

describe('InstanceCommunicationOverflowPolicy', () => {
  it('builds the shared delegation retry prompt', () => {
    expect(OVERFLOW_DELEGATION_GUIDANCE).toContain('[SYSTEM: Context Overflow Recovery]');
    expect(buildOverflowRetryMessage({
      message: 'summarize the workspace',
      contextBlock: 'ctx',
    })).toBe(`${'ctx'}\n\n${OVERFLOW_DELEGATION_GUIDANCE}\n\nsummarize the workspace`);
  });

  it('compacts and retries a thrown sendInput overflow once', async () => {
    const tracker = new InstanceCommunicationOverflowTracker();
    const adapter = { sendInput: vi.fn().mockResolvedValue(undefined) };
    const compactContext = vi.fn().mockResolvedValue(undefined);
    const instance = createInstance();
    const policy = new InstanceCommunicationOverflowPolicy(tracker, {
      getCompactContext: () => compactContext,
      addToOutputBuffer: (inst, msg) => { inst.outputBuffer.push(msg); },
      emitOutput: vi.fn(),
      transitionInstanceStatus: (inst, status) => { inst.status = status; },
      queueUpdate: vi.fn(),
      getAdapter: () => adapter as unknown as CliAdapter,
      resetCircuitBreaker: vi.fn(),
    });

    const handled = await policy.recoverSendInputOverflow({
      instanceId: 'inst-1',
      instance,
      errorText: 'The input token count (201,000) exceeds the maximum number of tokens allowed (200,000).',
      message: 'summarize the workspace',
      adapter: adapter as unknown as CliAdapter,
    });

    expect(handled).toBe(true);
    expect(compactContext).toHaveBeenCalledWith('inst-1');
    expect(adapter.sendInput).toHaveBeenCalledTimes(1);
    expect(String(adapter.sendInput.mock.calls[0]?.[0])).toContain('[SYSTEM: Context Overflow Recovery]');
    expect(instance.outputBuffer.some((message) => message.metadata?.['contextOverflow'] === true)).toBe(true);
    expect(tracker.hasRetried('inst-1')).toBe(true);
  });

  // LT-657: a retried Harness-authored turn keeps its provenance, so Codex
  // still receives it as a developer item rather than user input.
  it('keeps Harness provenance when retrying an internal turn after compaction', async () => {
    const tracker = new InstanceCommunicationOverflowTracker();
    const adapter = { sendInput: vi.fn().mockResolvedValue(undefined) };
    const instance = createInstance();
    const policy = new InstanceCommunicationOverflowPolicy(tracker, {
      getCompactContext: () => vi.fn().mockResolvedValue(undefined),
      addToOutputBuffer: (inst, msg) => { inst.outputBuffer.push(msg); },
      emitOutput: vi.fn(),
      transitionInstanceStatus: (inst, status) => { inst.status = status; },
      queueUpdate: vi.fn(),
      getAdapter: () => adapter as unknown as CliAdapter,
      resetCircuitBreaker: vi.fn(),
    });

    await policy.recoverSendInputOverflow({
      instanceId: 'inst-1',
      instance,
      errorText: 'The input token count (201,000) exceeds the maximum number of tokens allowed (200,000).',
      message: 'Automatic check-in',
      internalSource: 'async-work-continuation',
      adapter: adapter as unknown as CliAdapter,
    });

    expect(adapter.sendInput).toHaveBeenCalledTimes(1);
    expect(adapter.sendInput.mock.calls[0]?.[2]).toEqual({ internalSource: 'async-work-continuation' });
  });

  it('keeps Harness provenance when an adapter-error overflow retries the remembered turn', async () => {
    const tracker = new InstanceCommunicationOverflowTracker();
    tracker.rememberLastSent('inst-1', { message: 'Child finished', internalSource: 'child-announcement' });
    const adapter = { sendInput: vi.fn().mockResolvedValue(undefined) };
    const instance = createInstance();
    const policy = new InstanceCommunicationOverflowPolicy(tracker, {
      getCompactContext: () => vi.fn().mockResolvedValue(undefined),
      addToOutputBuffer: (inst, msg) => { inst.outputBuffer.push(msg); },
      emitOutput: vi.fn(),
      transitionInstanceStatus: (inst, status) => { inst.status = status; },
      queueUpdate: vi.fn(),
      getAdapter: () => adapter as unknown as CliAdapter,
      resetCircuitBreaker: vi.fn(),
    });

    await policy.recoverAdapterErrorOverflow({ instanceId: 'inst-1', instance, errorText: 'context overflow' });

    expect(adapter.sendInput).toHaveBeenCalledTimes(1);
    expect(adapter.sendInput.mock.calls[0]?.[2]).toEqual({ internalSource: 'child-announcement' });
  });

  it('goes idle instead of retrying a second overflow', async () => {
    const tracker = new InstanceCommunicationOverflowTracker();
    tracker.markRetried('inst-1');
    const adapter = { sendInput: vi.fn() };
    const instance = createInstance();
    const policy = new InstanceCommunicationOverflowPolicy(tracker, {
      getCompactContext: () => vi.fn().mockResolvedValue(undefined),
      addToOutputBuffer: (inst, msg) => { inst.outputBuffer.push(msg); },
      emitOutput: vi.fn(),
      transitionInstanceStatus: (inst, status) => { inst.status = status; },
      queueUpdate: vi.fn(),
      getAdapter: () => adapter as unknown as CliAdapter,
      resetCircuitBreaker: vi.fn(),
    });

    const handled = await policy.recoverSendInputOverflow({
      instanceId: 'inst-1',
      instance,
      errorText: 'context overflow',
      message: 'again',
      adapter: adapter as unknown as CliAdapter,
    });

    expect(handled).toBe(true);
    expect(adapter.sendInput).not.toHaveBeenCalled();
    expect(instance.status).toBe('idle');
  });

  it('idles when adapter-error overflow has no stored last turn', async () => {
    const tracker = new InstanceCommunicationOverflowTracker();
    const instance = createInstance();
    const policy = new InstanceCommunicationOverflowPolicy(tracker, {
      getCompactContext: () => vi.fn().mockResolvedValue(undefined),
      addToOutputBuffer: (inst, msg) => { inst.outputBuffer.push(msg); },
      emitOutput: vi.fn(),
      transitionInstanceStatus: (inst, status) => { inst.status = status; },
      queueUpdate: vi.fn(),
      getAdapter: () => undefined,
      resetCircuitBreaker: vi.fn(),
    });

    const handled = await policy.recoverAdapterErrorOverflow({
      instanceId: 'inst-1',
      instance,
      errorText: 'context length exceeded',
    });

    expect(handled).toBe(true);
    expect(instance.status).toBe('idle');
  });
});
