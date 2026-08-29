import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InstanceAsyncWorkRegistry } from './instance-async-work-registry';

describe('InstanceAsyncWorkRegistry', () => {
  let registry: InstanceAsyncWorkRegistry;

  beforeEach(() => {
    registry = new InstanceAsyncWorkRegistry();
  });

  it('inhibits hibernation while provider-owned background work is active', () => {
    registry.observe('instance-1', {
      phase: 'started',
      workId: 'toolu-shell',
      kind: 'background-shell',
    });

    expect(registry.hasInhibitor('instance-1')).toBe(true);
    expect(registry.hasInhibitor('instance-2')).toBe(false);
  });

  it('rekeys a provisional tool id without leaving a stale inhibitor', () => {
    registry.observe('instance-1', {
      phase: 'started',
      workId: 'toolu-shell',
      kind: 'background-shell',
    });
    registry.observe('instance-1', {
      phase: 'started',
      workId: 'bg-1',
      replacesWorkId: 'toolu-shell',
      kind: 'background-shell',
    });

    expect(registry.activeWorkIds('instance-1')).toEqual(['bg-1']);
  });

  it('keeps completion delivery inhibited until the continuation settles', () => {
    registry.observe('instance-1', {
      phase: 'started',
      workId: 'bg-1',
      kind: 'background-shell',
    });
    registry.observe('instance-1', {
      phase: 'terminal',
      workId: 'bg-1',
      kind: 'background-shell',
      status: 'completed',
    });

    expect(registry.activeWorkIds('instance-1')).toEqual([]);
    expect(registry.hasInhibitor('instance-1')).toBe(true);

    registry.finishCompletionDelivery('instance-1');
    expect(registry.hasInhibitor('instance-1')).toBe(false);
  });

  it('emits a terminal notification once for duplicate provider events', () => {
    const terminal = vi.fn();
    registry.on('work:terminal', terminal);
    const event = {
      phase: 'terminal' as const,
      workId: 'bg-1',
      kind: 'background-shell' as const,
      status: 'completed' as const,
    };

    registry.observe('instance-1', event);
    registry.observe('instance-1', event);

    expect(terminal).toHaveBeenCalledTimes(1);
  });

  it('releases a failed launch without scheduling another model turn', () => {
    const terminal = vi.fn();
    registry.on('work:terminal', terminal);
    registry.observe('instance-1', {
      phase: 'started',
      workId: 'toolu-shell',
      kind: 'background-shell',
    });

    registry.observe('instance-1', {
      phase: 'terminal',
      workId: 'toolu-shell',
      kind: 'background-shell',
      status: 'failed',
      continueOnCompletion: false,
    });

    expect(terminal).not.toHaveBeenCalled();
    expect(registry.hasInhibitor('instance-1')).toBe(false);
  });

  it('clears active work and pending delivery when the provider exits', () => {
    registry.observe('instance-1', {
      phase: 'started',
      workId: 'bg-1',
      kind: 'background-shell',
    });
    registry.beginCompletionDelivery('instance-1');

    registry.clearInstance('instance-1');

    expect(registry.activeWorkIds('instance-1')).toEqual([]);
    expect(registry.hasInhibitor('instance-1')).toBe(false);
  });

  it('treats progress as activity without inventing a new work record', () => {
    registry.observe('instance-1', {
      phase: 'progress',
      workId: 'unknown-tool',
      kind: 'background-shell',
    });

    expect(registry.activeWorkIds('instance-1')).toEqual([]);
    expect(registry.hasInhibitor('instance-1')).toBe(false);
  });
});
