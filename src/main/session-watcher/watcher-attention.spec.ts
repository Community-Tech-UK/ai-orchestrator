import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionWatcher, WatcherFlag } from './session-watcher';
import { WatcherAttention, getWatcherAttention } from './watcher-attention';

const flag = (instanceId: string, overrides: Partial<WatcherFlag> = {}): WatcherFlag => ({
  instanceId, requestCount: 3, question: 'Shall I push it?', closing: 'Shall I push it?', stop: 'asked_before_outward_step',
  acceptsYes: true, since: 1_000, ...overrides,
});

describe('WatcherAttention', () => {
  let watcher: EventEmitter;
  let pushed: WatcherFlag[][];
  let attention: WatcherAttention;

  beforeEach(() => {
    WatcherAttention._resetForTesting();
    watcher = new EventEmitter();
    pushed = [];
    attention = getWatcherAttention();
    attention.attach(watcher as unknown as SessionWatcher, (flags) => pushed.push(flags));
  });

  it('is one shared registry', () => {
    expect(getWatcherAttention()).toBe(attention);
  });

  it('keeps the flag the watcher raises and lists it', () => {
    watcher.emit('flag', flag('a'));
    expect(attention.get('a')).toEqual(flag('a'));
    expect(attention.list()).toEqual([flag('a')]);
  });

  it('pushes the whole list on every change, oldest first', () => {
    watcher.emit('flag', flag('b', { since: 2_000 }));
    watcher.emit('flag', flag('a', { since: 1_000 }));
    expect(pushed).toHaveLength(2);
    expect(pushed[1]?.map((item) => item.instanceId)).toEqual(['a', 'b']);
  });

  it('replaces the flag of a session that is flagged again', () => {
    watcher.emit('flag', flag('a', { requestCount: 3 }));
    watcher.emit('flag', flag('a', { requestCount: 4 }));
    expect(attention.list()).toHaveLength(1);
    expect(attention.get('a')?.requestCount).toBe(4);
  });

  it('drops the flag when the watcher clears the session, and pushes the new list', () => {
    watcher.emit('flag', flag('a'));
    watcher.emit('clear', 'a');
    expect(attention.get('a')).toBeUndefined();
    expect(pushed.at(-1)).toEqual([]);
  });

  it('says nothing when a clear changes nothing', () => {
    watcher.emit('clear', 'unknown');
    expect(pushed).toEqual([]);
  });

  it('can drop a flag itself, for a muted session', () => {
    watcher.emit('flag', flag('a'));
    attention.clear('a');
    expect(attention.list()).toEqual([]);
    expect(pushed.at(-1)).toEqual([]);
  });

  it('stops following a watcher it was detached from, and forgets its flags', () => {
    watcher.emit('flag', flag('a'));
    attention.detach();
    watcher.emit('flag', flag('b'));
    expect(attention.list()).toEqual([]);
    expect(watcher.listenerCount('flag')).toBe(0);
    expect(watcher.listenerCount('clear')).toBe(0);
  });

  it('follows only the latest watcher after a second attach', () => {
    const second = new EventEmitter();
    const onChange = vi.fn();
    attention.attach(second as unknown as SessionWatcher, onChange);
    watcher.emit('flag', flag('old'));
    second.emit('flag', flag('new'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(attention.list().map((item) => item.instanceId)).toEqual(['new']);
  });
});
