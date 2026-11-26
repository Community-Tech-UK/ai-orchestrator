import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import { observeClaudeSubagentUsage, flushClaudeSubagentUsage } from '../cli/adapters/claude-subagent-usage';
import { createInstance } from '../../shared/types/instance.types';
import { InstanceStateManager } from './instance-state';

describe('native helper lifecycle in instance state', () => {
  let state: InstanceStateManager;
  let adapter: EventEmitter;
  let id: string;
  const started = (task: string, background = false) => ({ type: 'system', subtype: 'task_started',
    task_id: task, tool_use_id: `tool-${task}`, task_type: 'local_agent', is_backgrounded: background });
  const progress = (task: string) => ({ type: 'system', subtype: 'task_progress', task_id: task,
    usage: { total_tokens: 100, tool_uses: 2, duration_ms: 300 } });
  const observe = (message: unknown) => observeClaudeSubagentUsage(adapter, message);
  const expectRunning = (running: number) => expect(state.getInstance(id)).toMatchObject({ nativeHelpers: { running } });
  beforeEach(() => {
    vi.useFakeTimers();
    state = new InstanceStateManager();
    const instance = createInstance({ workingDirectory: '/tmp', provider: 'claude' });
    instance.status = 'busy';
    id = instance.id;
    state.setInstance(instance);
    adapter = new EventEmitter();
    state.setAdapter(id, adapter as CliAdapter);
  });
  afterEach(() => { state.destroy(); vi.useRealTimers(); });

  it('counts native foreground starts and usage without a child session, and closes at turn result', () => {
    observe(started('one'));
    expectRunning(1);
    observe(progress('one'));
    observe({ ...progress('one'), task_id: undefined, tool_use_id: 'tool-one' });
    expectRunning(1);
    observe(progress('legacy'));
    expectRunning(2);
    flushClaudeSubagentUsage(adapter);
    expectRunning(0);
    observe(progress('one'));
    expectRunning(0);
  });

  it('keeps background helpers after foreground result, excludes shells, reconciles snapshots and stops', () => {
    observe(started('foreground'));
    observe(started('background', true));
    observe({ ...started('shell', true), task_type: 'local_bash' });
    observe(progress('shell'));
    expectRunning(2);
    flushClaudeSubagentUsage(adapter);
    expectRunning(1);
    observe({ type: 'system', subtype: 'task_notification', task_id: 'background', status: 'stopped' });
    expectRunning(0);
    observe(progress('background'));
    expectRunning(0);
    observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [
      { task_id: 'snapshot', task_type: 'local_agent' }, { task_id: 'shell-2', task_type: 'local_bash' },
    ] });
    expectRunning(1);
    observe(started('snapshot', true));
    expectRunning(1);
    observe(started('next-foreground'));
    observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    expectRunning(1);
  });

  it('publishes the native summary in batched typed updates and serialization', () => {
    const batches: unknown[] = [];
    state.on('batch-update', batch => batches.push(batch));
    observe(progress('one'));
    state.queueUpdate(id, 'busy');
    vi.advanceTimersByTime(1000);
    expect(batches).toEqual([expect.objectContaining({ updates: [expect.objectContaining({ nativeHelpers: { running: 1 } })] })]);
    expect(state.serializeForIpc(state.getInstance(id)!)).toMatchObject({ nativeHelpers: { running: 1 } });
  });

  it.each(['deleteAdapter', 'deleteRuntimeAdapter', 'deleteInstance', 'deleteRuntimeInstance', 'destroy'] as const)(
  'cleans native listeners and ignores late events after %s', operation => {
    observe(progress('old'));
    if (operation === 'destroy') state.destroy();
    else state[operation](id);
    expect(adapter.listenerCount('native_helpers')).toBe(0);
    observe(progress('late'));
    if (state.getInstance(id)) expectRunning(0);
  });

  it('clears on replacement and ignores stale adapter events', () => {
    observe(progress('old'));
    const previous = adapter;
    adapter = new EventEmitter();
    state.setAdapter(id, adapter as CliAdapter);
    expectRunning(0);
    expect(previous.listenerCount('native_helpers')).toBe(0);
    observeClaudeSubagentUsage(previous, progress('stale'));
    expectRunning(0);
    observe(progress('fresh'));
    expectRunning(1);
    adapter.emit('exit', 0, null);
    expectRunning(0);
    observe(progress('after-exit'));
    expectRunning(0);
    expect(adapter.listenerCount('native_helpers')).toBe(0);
  });

  it('clears cancelled work and does not revive it from late progress', () => {
    observe(progress('old'));
    state.getInstance(id)!.status = 'cancelled';
    state.queueUpdate(id, 'cancelled');
    expectRunning(0);
    observe(progress('late'));
    expectRunning(0);
  });

  it('rejects malformed snapshot identities instead of inventing unaddressable helpers', () => {
    observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [
      { task_id: '', task_type: 'local_agent' }, { task_id: 'x'.repeat(513), task_type: 'local_agent' },
    ] });
    observe(progress('valid'));
    expectRunning(1);
  });

  it('merges snapshot and usage identities, promotes foreground work and keeps it after result', () => {
    observe(progress('tool-promoted'));
    observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'promoted', task_type: 'local_agent' }] });
    observe(started('promoted', true));
    expectRunning(1);
    flushClaudeSubagentUsage(adapter);
    expectRunning(1);
    observe({ type: 'system', subtype: 'task_notification', task_id: 'promoted', status: 'failed' });
    expectRunning(0);
    observe(progress('updated'));
    observe({ type: 'system', subtype: 'task_updated', tool_use_id: 'updated', patch: { is_backgrounded: true } });
    flushClaudeSubagentUsage(adapter);
    expectRunning(1);
  });

  it('recognizes shell identities in background snapshots before their usage arrives', () => {
    observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'shell', task_type: 'local_bash' }] });
    observe(progress('shell'));
    expectRunning(0);
  });

  it('withdraws an unclassified usage fallback when a later snapshot identifies a shell', () => {
    observe(progress('unknown'));
    expectRunning(1);
    observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'unknown', task_type: 'local_bash' }] });
    expectRunning(0);
  });

  it('keeps native listeners and timers bounded across repeated adapter replacements', () => {
    const timers = vi.getTimerCount();
    for (let index = 0; index < 30; index++) {
      observe(progress(`helper-${index}`));
      const previous = adapter;
      adapter = new EventEmitter();
      state.setAdapter(id, adapter as CliAdapter);
      expect(previous.listenerCount('native_helpers')).toBe(0);
      expect(previous.listenerCount('exit')).toBe(0);
      expect(adapter.listenerCount('native_helpers')).toBe(1);
      expectRunning(0);
    }
    expect(vi.getTimerCount()).toBe(timers);
  });
});
