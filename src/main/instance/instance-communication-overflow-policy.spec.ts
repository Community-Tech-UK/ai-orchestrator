import { describe, expect, it, vi } from 'vitest';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import type { Instance } from '../../shared/types/instance.types';
import { InstanceCommunicationOverflowTracker } from './instance-communication-overflow-tracker';
import {
  buildOverflowRetryMessage,
  InstanceCommunicationOverflowPolicy,
} from './instance-communication-overflow-policy';
import { getInstanceTurnEnding, invalidateInstanceRecoveryEpoch } from './instance-turn-ending-state';

function createInstance(): Instance {
  return {
    id: 'inst-1',
    status: 'busy',
    outputBuffer: [],
  } as unknown as Instance;
}

describe('InstanceCommunicationOverflowPolicy', () => {
  it('does not compact a second time after partial assistant output on the same logical send', async () => {
    const tracker = new InstanceCommunicationOverflowTracker();
    tracker.rememberLastSent('inst-1', { message: 'original request' });
    const compactContext = vi.fn().mockResolvedValue(undefined);
    const adapter = { sendInput: vi.fn().mockResolvedValue(undefined) };
    const instance = createInstance();
    const policy = new InstanceCommunicationOverflowPolicy(tracker, {
      getCompactContext: () => compactContext,
      addToOutputBuffer: (inst, msg) => { inst.outputBuffer.push(msg); },
      emitOutput: vi.fn(), transitionInstanceStatus: (inst, status) => { inst.status = status; },
      queueUpdate: vi.fn(), getAdapter: () => adapter as unknown as CliAdapter, resetCircuitBreaker: vi.fn(),
    });
    await policy.recoverAdapterErrorOverflow({ instanceId: 'inst-1', instance, errorText: 'context overflow' });
    tracker.clearRetry('inst-1'); // production clears this on partial assistant output
    await policy.recoverAdapterErrorOverflow({ instanceId: 'inst-1', instance, errorText: 'context overflow' });
    expect(compactContext).toHaveBeenCalledTimes(1);
    expect(adapter.sendInput).toHaveBeenCalledOnce();
    expect(adapter.sendInput).toHaveBeenCalledWith('original request', undefined, { internalSource: undefined, dispatch: { assertCurrent: expect.any(Function) } });
  });
  it('retries exactly the original request without appending instructions', () => {
    expect(buildOverflowRetryMessage({
      message: 'summarize the workspace',
      contextBlock: 'ctx',
    })).toBe('ctx\n\nsummarize the workspace');
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
    expect(adapter.sendInput.mock.calls[0]?.[0]).toBe('summarize the workspace');
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
    expect(adapter.sendInput.mock.calls[0]?.[2]).toEqual({ internalSource: 'async-work-continuation', dispatch: { assertCurrent: expect.any(Function) } });
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
    expect(adapter.sendInput.mock.calls[0]?.[2]).toEqual({ internalSource: 'child-announcement', dispatch: { assertCurrent: expect.any(Function) } });
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

  it.each(['claude-cli', 'opencode-acp'])('leaves exhausted %s reactive compaction with the native owner', async (name) => {
    const compactContext = vi.fn();
    const adapter = { getName: () => name, sendInput: vi.fn() };
    const instance = createInstance();
    const policy = new InstanceCommunicationOverflowPolicy(new InstanceCommunicationOverflowTracker(), {
      getCompactContext: () => compactContext, addToOutputBuffer: (inst, msg) => { inst.outputBuffer.push(msg); },
      emitOutput: vi.fn(), transitionInstanceStatus: (inst, status) => { inst.status = status; },
      queueUpdate: vi.fn(), getAdapter: () => adapter as unknown as CliAdapter, resetCircuitBreaker: vi.fn(),
    });
    await policy.recoverSendInputOverflow({ instanceId: instance.id, instance, errorText: 'context overflow', message: 'original', adapter: adapter as unknown as CliAdapter });
    expect(compactContext).not.toHaveBeenCalled();
    expect(adapter.sendInput).not.toHaveBeenCalled();
    expect(instance.status).toBe('idle');
    expect(getInstanceTurnEnding(instance.id)).toBe('context_overflow');
  });

  it.each(['stop', 'new-user-input', 'new-adapter'])('does not dispatch or change status after %s during compaction', async (cause) => {
    const tracker = new InstanceCommunicationOverflowTracker();
    const adapter = { sendInput: vi.fn().mockResolvedValue(undefined) };
    let currentAdapter = adapter;
    let release!: () => void;
    const compactContext = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const instance = createInstance();
    const transitionInstanceStatus = vi.fn();
    const policy = new InstanceCommunicationOverflowPolicy(tracker, {
      getCompactContext: () => compactContext, addToOutputBuffer: (inst, msg) => { inst.outputBuffer.push(msg); },
      emitOutput: vi.fn(), transitionInstanceStatus, queueUpdate: vi.fn(),
      getAdapter: () => currentAdapter as unknown as CliAdapter, resetCircuitBreaker: vi.fn(),
    });
    const pending = policy.recoverSendInputOverflow({ instanceId: instance.id, instance, errorText: 'context overflow', message: 'original', adapter: adapter as unknown as CliAdapter });
    if (cause === 'new-adapter') currentAdapter = { sendInput: vi.fn() };
    else invalidateInstanceRecoveryEpoch(instance.id); // actual coordinator boundary, before requestCount changes
    release();
    await expect(pending).resolves.toBe(true);
    expect(adapter.sendInput).not.toHaveBeenCalled();
    expect(transitionInstanceStatus).not.toHaveBeenCalled();
  });

  it('consumes the compact attempt even if compaction fails', async () => {
    const compactContext = vi.fn().mockRejectedValue(new Error('fixture compaction failure'));
    const adapter = { sendInput: vi.fn() };
    const instance = createInstance();
    const policy = new InstanceCommunicationOverflowPolicy(new InstanceCommunicationOverflowTracker(), {
      getCompactContext: () => compactContext, addToOutputBuffer: (inst, msg) => { inst.outputBuffer.push(msg); },
      emitOutput: vi.fn(), transitionInstanceStatus: (inst, status) => { inst.status = status; },
      queueUpdate: vi.fn(), getAdapter: () => adapter as unknown as CliAdapter, resetCircuitBreaker: vi.fn(),
    });
    const input = { instanceId: instance.id, instance, errorText: 'context overflow', message: 'original', adapter: adapter as unknown as CliAdapter };
    await policy.recoverSendInputOverflow(input);
    await policy.recoverSendInputOverflow(input);
    expect(compactContext).toHaveBeenCalledOnce();
    expect(adapter.sendInput).not.toHaveBeenCalled();
  });

  it('honors Stop raised synchronously by the retrying notice before setting busy or dispatching', async () => {
    const adapter = { sendInput: vi.fn() };
    const instance = createInstance();
    const transitionInstanceStatus = vi.fn();
    const policy = new InstanceCommunicationOverflowPolicy(new InstanceCommunicationOverflowTracker(), {
      getCompactContext: () => vi.fn().mockResolvedValue(undefined),
      addToOutputBuffer: (inst, msg) => { inst.outputBuffer.push(msg); },
      emitOutput: (_id, msg) => { if (msg.metadata?.['retrying']) invalidateInstanceRecoveryEpoch(instance.id); },
      transitionInstanceStatus, queueUpdate: vi.fn(), getAdapter: () => adapter as unknown as CliAdapter, resetCircuitBreaker: vi.fn(),
    });
    await policy.recoverSendInputOverflow({ instanceId: instance.id, instance, errorText: 'context overflow', message: 'original', adapter: adapter as unknown as CliAdapter });
    expect(transitionInstanceStatus).not.toHaveBeenCalled();
    expect(adapter.sendInput).not.toHaveBeenCalled();
  });
});
