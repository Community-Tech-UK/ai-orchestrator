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

  describe('background work summary', () => {
    let now: number;
    let clockRegistry: InstanceAsyncWorkRegistry;
    let changes: { instanceId: string; summary: { count: number; since: number } | null }[];

    beforeEach(() => {
      now = 1_000;
      clockRegistry = new InstanceAsyncWorkRegistry(() => now);
      changes = [];
      clockRegistry.on('work:changed', (change) => changes.push(change));
    });

    it('reports the count and the oldest start time, keeping it across a provisional rekey', () => {
      clockRegistry.observe('i1', { phase: 'started', workId: 'toolu-shell', kind: 'background-shell' });
      now = 5_000;
      clockRegistry.observe('i1', {
        phase: 'started',
        workId: 'bg-1',
        replacesWorkId: 'toolu-shell',
        kind: 'background-shell',
      });
      clockRegistry.observe('i1', { phase: 'started', workId: 'agent-1', kind: 'subagent' });

      expect(clockRegistry.backgroundWorkSummary('i1')).toEqual({ count: 2, since: 1_000 });
      expect(changes.at(-1)).toEqual({ instanceId: 'i1', summary: { count: 2, since: 1_000 } });
    });

    it('does not announce a change for a duplicate start', () => {
      clockRegistry.observe('i1', { phase: 'started', workId: 'bg-1', kind: 'background-shell' });
      clockRegistry.observe('i1', { phase: 'started', workId: 'bg-1', kind: 'background-shell' });

      expect(changes).toHaveLength(1);
    });

    it('replaces the tracked set with a provider snapshot, preserving known start times', () => {
      clockRegistry.observe('i1', { phase: 'started', workId: 'bg-1', kind: 'background-shell' });
      clockRegistry.observe('i1', { phase: 'started', workId: 'stale', kind: 'background-shell' });
      now = 9_000;

      clockRegistry.observe('i1', {
        phase: 'snapshot',
        work: [
          { workId: 'bg-1', kind: 'background-shell' },
          { workId: 'agent-2', kind: 'subagent' },
        ],
      });

      expect(clockRegistry.activeWorkIds('i1')).toEqual(['agent-2', 'bg-1']);
      expect(clockRegistry.backgroundWorkSummary('i1')).toEqual({ count: 2, since: 1_000 });

      clockRegistry.observe('i1', { phase: 'snapshot', work: [] });
      expect(clockRegistry.backgroundWorkSummary('i1')).toBeNull();
      expect(clockRegistry.hasInhibitor('i1')).toBe(false);
      expect(changes.at(-1)).toEqual({ instanceId: 'i1', summary: null });
    });

    it('announces cleared work when the provider exits', () => {
      clockRegistry.observe('i1', { phase: 'started', workId: 'bg-1', kind: 'background-shell' });
      clockRegistry.clearInstance('i1');

      expect(changes.at(-1)).toEqual({ instanceId: 'i1', summary: null });
      expect(clockRegistry.instancesWithActiveWork()).toEqual([]);
    });

    it('lists instances that still own background work', () => {
      clockRegistry.observe('i1', { phase: 'started', workId: 'bg-1', kind: 'background-shell' });
      clockRegistry.observe('i2', { phase: 'started', workId: 'bg-2', kind: 'background-shell' });
      clockRegistry.observe('i2', {
        phase: 'terminal',
        workId: 'bg-2',
        kind: 'background-shell',
        status: 'completed',
      });

      expect(clockRegistry.instancesWithActiveWork()).toEqual(['i1']);
    });
  });

  it('delivers one terminal notification when two parsers report the same task with different kinds', () => {
    const terminal = vi.fn();
    registry.on('work:terminal', terminal);

    registry.observe('instance-1', {
      phase: 'terminal', workId: 'a-1', replacesWorkId: 'toolu-1', kind: 'subagent', status: 'completed',
    });
    registry.observe('instance-1', {
      phase: 'terminal', workId: 'a-1', replacesWorkId: 'toolu-1', kind: 'background-shell', status: 'completed',
    });

    expect(terminal).toHaveBeenCalledTimes(1);
  });

  it('announces a provider-initiated resume', () => {
    const resumed = vi.fn();
    registry.on('work:provider-resumed', resumed);

    registry.observe('instance-1', { phase: 'provider-resumed' });

    expect(resumed).toHaveBeenCalledWith({ instanceId: 'instance-1' });
    expect(registry.hasInhibitor('instance-1')).toBe(false);
  });
});
