import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const logs = vi.hoisted(() => ({ debug: vi.fn() }));
vi.mock('../../logging/logger', () => ({ getLogger: () => logs }));
import { AcpDelegatedTaskLiveness, type AcpChildActivity } from './acp-delegated-task-liveness';

describe('delegated task activity', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10_000); logs.debug.mockClear(); });
  afterEach(() => vi.useRealTimers());

  const task = { status: 'in_progress' as const, title: 'task', kind: 'think', rawInput: { prompt: 'Review', description: 'Gate' } };

  it('times a silent delegated task out on the ordinary tool inactivity lease', () => {
    const liveness = new AcpDelegatedTaskLiveness();
    liveness.observe('t', task, 'parent');
    vi.advanceTimersByTime(40);
    expect(liveness.leaseMs(10, 60, 240)).toBe(20);
  });

  it('counts matching child work, ignores old and unrelated children and keeps an absolute ceiling', () => {
    let progress: ((child: AcpChildActivity) => void) | undefined;
    const liveness = new AcpDelegatedTaskLiveness({ start: (_, callback) => { progress = callback; return () => undefined; } });
    liveness.observe('t', task, 'parent');
    vi.advanceTimersByTime(40);
    progress?.({ sessionId: 'old', title: 'Gate (@agent subagent)', createdAt: 9_000 });
    progress?.({ sessionId: 'other', title: 'Other task', createdAt: 10_001 });
    expect(liveness.leaseMs(10, 60, 100)).toBe(20);
    progress?.({ sessionId: 'child', title: 'Gate (@agent subagent)', createdAt: 10_001 });
    expect(liveness.leaseMs(10, 60, 100)).toBe(60);
    vi.advanceTimersByTime(40);
    progress?.({ sessionId: 'child', title: 'renamed', createdAt: 10_001 });
    expect(liveness.leaseMs(10, 60, 100)).toBe(20);
  });

  it('background updates release the source and do not retain a task ceiling', () => {
    let stopped = false;
    const liveness = new AcpDelegatedTaskLiveness({ start: () => () => { stopped = true; } });
    liveness.observe('t', task, 'parent');
    liveness.observe('t', { ...task, rawInput: { ...task.rawInput, background: true } }, 'parent');
    expect(stopped).toBe(true);
    expect(liveness.leaseMs(10, 60, 100)).toBe(10);
  });

  it('accepts native task ownership when child creation precedes delayed ACP observation', () => {
    let progress: ((child: AcpChildActivity) => void) | undefined;
    const liveness = new AcpDelegatedTaskLiveness({ start: (_, callback) => { progress = callback; return () => undefined; } });
    liveness.observe('native-call', task, 'parent');
    vi.advanceTimersByTime(40);
    const child = { sessionId: 'child', title: 'Gate', createdAt: 9_980, toolCallId: 'native-call' };
    progress?.(child);
    expect(liveness.leaseMs(10, 60, 240)).toBe(60);
    progress?.({ ...child, sessionId: 'old-unrelated', toolCallId: 'other-call' });
    vi.advanceTimersByTime(20);
    expect(liveness.leaseMs(10, 60, 240)).toBe(40);
  });

  it('never assigns one native child to two active parent tasks', () => {
    let progress: ((child: AcpChildActivity) => void) | undefined;
    const liveness = new AcpDelegatedTaskLiveness({ start: (_, callback) => { progress = callback; return () => undefined; } });
    liveness.observe('first', task, 'parent');
    liveness.observe('second', task, 'parent');
    vi.advanceTimersByTime(40);
    progress?.({ sessionId: 'ambiguous', title: 'Gate', createdAt: 10_001 });
    expect(liveness.leaseMs(10, 60, 240)).toBe(20);
    const first = { sessionId: 'child', title: 'Gate', createdAt: 9_980, toolCallId: 'first' };
    progress?.(first);
    const second = { ...first, toolCallId: 'second' };
    progress?.(second);
    expect(liveness.leaseMs(10, 60, 240)).toBe(20);
  });

  it('clearing a turn ignores late source callbacks', () => {
    let progress: ((child: AcpChildActivity) => void) | undefined;
    const liveness = new AcpDelegatedTaskLiveness({ start: (_, callback) => { progress = callback; return () => undefined; } });
    liveness.observe('t', task, 'parent');
    liveness.clear();
    progress?.({ sessionId: 'child', title: 'Gate', createdAt: 10_001 });
    expect(liveness.leaseMs(10, 60, 100)).toBe(10);
  });

  it('native promotion revokes an accepted child lease and fences late work across a new source', () => {
    const callbacks: { progress: (child: AcpChildActivity) => void; background?: (child: AcpChildActivity) => void }[] = [];
    const stop = vi.fn();
    const changed = vi.fn();
    const liveness = new AcpDelegatedTaskLiveness({ start: (_, progress, background) => {
      callbacks.push({ progress, background });
      return stop;
    } }, changed);
    liveness.observe('native-call', task, 'parent');
    const child = { sessionId: 'child', title: 'Gate', createdAt: 9_980, toolCallId: 'native-call' };
    vi.advanceTimersByTime(40);
    callbacks[0].progress(child);
    expect(liveness.leaseMs(240, 60, 240)).toBe(60);
    callbacks[0].background?.({ ...child, toolCallId: 'unrelated' });
    expect(liveness.leaseMs(240, 60, 240)).toBe(60);
    callbacks[0].background?.(child);
    expect(stop).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledTimes(2);
    expect(liveness.leaseMs(240, 60, 240)).toBe(20);
    expect(liveness.describe(60, 240)).toBeUndefined();
    // An ACP snapshot can still carry the original foreground input after promotion.
    liveness.observe('native-call', task, 'parent');
    expect(callbacks).toHaveLength(1);
    vi.advanceTimersByTime(40);
    callbacks[0].progress(child);
    expect(liveness.leaseMs(240, 60, 240)).toBe(20);
    liveness.observe('new-call', task, 'parent');
    expect(callbacks).toHaveLength(2);
    callbacks[0].progress({ ...child, toolCallId: 'new-call' });
    expect(changed).toHaveBeenCalledTimes(2);
    callbacks[1].progress({ ...child, sessionId: 'new-child', toolCallId: 'new-call' });
    expect(changed).toHaveBeenCalledTimes(3);
    // Background work must not cap a different foreground task's lease either.
    vi.advanceTimersByTime(40);
    callbacks[1].progress({ ...child, sessionId: 'new-child', toolCallId: 'new-call' });
    expect(liveness.leaseMs(240, 60, 240)).toBe(60);
  });

  it('records accepted child work as safe lease evidence and reports its actual age', () => {
    let progress: ((child: AcpChildActivity) => void) | undefined;
    const liveness = new AcpDelegatedTaskLiveness({ start: (_, callback) => { progress = callback; return () => undefined; } });
    liveness.observe('t', { ...task, rawInput: { ...task.rawInput, task_id: 'child' } }, 'parent');
    progress?.({ sessionId: 'unrelated', title: 'DO_NOT_LOG_BODY', createdAt: 10_001 });
    expect(logs.debug).not.toHaveBeenCalled();
    vi.advanceTimersByTime(40);
    progress?.({ sessionId: 'child', title: 'DO_NOT_LOG_BODY', createdAt: 10_001 });
    expect(logs.debug).toHaveBeenCalledWith('ACP delegated lease refreshed', {
      parentSessionId: 'parent', childSessionId: 'child', lastChildActivityAt: 10_040, leaseRefreshSource: 'child-event',
    });
    vi.advanceTimersByTime(20);
    expect(liveness.describe(60, 240)).toMatchObject({ childActivity: 'observed', lastChildActivityAgeMs: 20, leaseRemainingMs: 40 });
    expect(JSON.stringify(logs.debug.mock.calls)).not.toContain('DO_NOT_LOG_BODY');
  });
});
