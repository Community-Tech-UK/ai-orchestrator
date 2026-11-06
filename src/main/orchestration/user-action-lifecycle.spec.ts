import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import type { UserActionRequest } from './orchestration-handler.types';
import { UserActionLifecycle, type SettledUserAction } from './user-action-lifecycle';

function request(id: string, instanceId = 'i-1', overrides: Partial<UserActionRequest> = {}): UserActionRequest {
  return { id, instanceId, requestType: 'confirm', title: 'Proceed?', message: 'Run it?', createdAt: Date.now(), ...overrides };
}

describe('UserActionLifecycle', () => {
  let announced: SettledUserAction[];
  let lifecycle: UserActionLifecycle;

  beforeEach(() => {
    vi.useFakeTimers();
    announced = [];
    lifecycle = new UserActionLifecycle((settled) => announced.push(settled));
  });

  afterEach(() => {
    lifecycle.dispose();
    vi.useRealTimers();
  });

  describe('what is waiting', () => {
    it('lists open requests, all of them or one session\'s', () => {
      lifecycle.open(request('a', 'i-1'));
      lifecycle.open(request('b', 'i-2'));

      expect(lifecycle.list().map((r) => r.id)).toEqual(['a', 'b']);
      expect(lifecycle.listForInstance('i-2').map((r) => r.id)).toEqual(['b']);
      expect(lifecycle.get('a')?.title).toBe('Proceed?');
      expect(lifecycle.get('missing')).toBeUndefined();
    });
  });

  describe('being answered', () => {
    it('closes the request once, tells everyone how it ended and says how long it waited', () => {
      lifecycle.open(request('a'));
      vi.advanceTimersByTime(4_000);

      const settled = lifecycle.settle('a', { reason: 'decided', approved: true, selectedOption: 'go', via: 'window' });

      expect(settled).toMatchObject({
        request: { id: 'a' },
        waitedMs: 4_000,
        end: { reason: 'decided', approved: true, selectedOption: 'go', via: 'window' },
      });
      expect(announced).toHaveLength(1);
      expect(lifecycle.get('a')).toBeUndefined();
      expect(lifecycle.list()).toEqual([]);
    });

    it('refuses a second answer, so a late reply is stale rather than a second success', () => {
      lifecycle.open(request('a'));
      lifecycle.settle('a', { reason: 'decided', approved: true, via: 'window' });

      expect(lifecycle.settle('a', { reason: 'decided', approved: false, via: 'elsewhere' })).toBeNull();
      expect(announced).toHaveLength(1);
    });

    it('lets whoever is waiting in process carry on, with the same outcome', () => {
      const onSettled = vi.fn();
      lifecycle.open(request('a'), { onSettled });

      lifecycle.settle('a', { reason: 'decided', approved: true, selectedOption: 'allow_once', via: 'window' });

      expect(onSettled).toHaveBeenCalledTimes(1);
      expect(onSettled.mock.calls[0]?.[0]).toMatchObject({ end: { reason: 'decided', selectedOption: 'allow_once' } });
    });

    it('stops the clock when the answer arrives, so no timeout follows it', () => {
      lifecycle.open(request('a'), { timeoutMs: 300_000 });
      expect(vi.getTimerCount()).toBe(1);

      lifecycle.settle('a', { reason: 'decided', approved: true, via: 'window' });
      expect(vi.getTimerCount()).toBe(0);

      vi.advanceTimersByTime(600_000);
      expect(announced).toHaveLength(1);
      expect(announced[0]?.end.reason).toBe('decided');
    });
  });

  describe('running out of time', () => {
    it('closes the request as timed out and announces it', () => {
      const onSettled = vi.fn();
      lifecycle.open(request('a'), { timeoutMs: 300_000, onSettled });

      vi.advanceTimersByTime(299_999);
      expect(announced).toEqual([]);
      vi.advanceTimersByTime(1);

      expect(announced).toHaveLength(1);
      expect(announced[0]).toMatchObject({ waitedMs: 300_000, end: { reason: 'timeout' } });
      expect(onSettled).toHaveBeenCalledTimes(1);
      expect(lifecycle.list()).toEqual([]);
    });

    it('turns a reply that arrives afterwards into a stale one', () => {
      lifecycle.open(request('a'), { timeoutMs: 1_000 });
      vi.advanceTimersByTime(1_000);

      expect(lifecycle.settle('a', { reason: 'decided', approved: true, via: 'window' })).toBeNull();
      expect(announced).toHaveLength(1);
    });

    it('never times out a request opened without a limit', () => {
      lifecycle.open(request('a'));
      expect(vi.getTimerCount()).toBe(0);

      vi.advanceTimersByTime(24 * 60 * 60_000);

      expect(announced).toEqual([]);
      expect(lifecycle.get('a')).toBeDefined();
    });
  });

  describe('the session ending', () => {
    it('closes every request of that session and leaves other sessions alone', () => {
      lifecycle.open(request('a', 'i-1'), { timeoutMs: 1_000 });
      lifecycle.open(request('b', 'i-1'));
      lifecycle.open(request('c', 'i-2'), { timeoutMs: 1_000 });

      const closed = lifecycle.settleForInstance('i-1', { reason: 'cancelled' });

      expect(closed).toBe(2);
      expect(announced.map((s) => [s.request.id, s.end.reason])).toEqual([['a', 'cancelled'], ['b', 'cancelled']]);
      expect(lifecycle.list().map((r) => r.id)).toEqual(['c']);
      expect(vi.getTimerCount()).toBe(1);
    });

    it('can close just some of a session\'s requests', () => {
      lifecycle.open(request('a', 'i-1', { requestType: 'select_option' }));
      lifecycle.open(request('b', 'i-1', { requestType: 'confirm' }));

      lifecycle.settleForInstance('i-1', { reason: 'exited' }, (r) => r.requestType === 'confirm');

      expect(lifecycle.list().map((r) => r.id)).toEqual(['a']);
    });

    it('leaves no timer running for a request that was cancelled', () => {
      lifecycle.open(request('a'), { timeoutMs: 300_000 });
      lifecycle.settleForInstance('i-1', { reason: 'exited' });

      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('when a listener misbehaves', () => {
    it('still closes the request and finishes the rest', () => {
      const failing = new UserActionLifecycle(() => { throw new Error('listener broke'); });
      const onSettled = vi.fn();
      failing.open(request('a'), { onSettled });
      failing.open(request('b'));

      expect(() => failing.settleForInstance('i-1', { reason: 'cancelled' })).not.toThrow();

      expect(failing.list()).toEqual([]);
      expect(onSettled).toHaveBeenCalledTimes(1);
    });

    it('still lets an in-process waiter carry on if it throws', () => {
      lifecycle.open(request('a'), { onSettled: () => { throw new Error('waiter broke'); } });

      expect(() => lifecycle.settle('a', { reason: 'decided', approved: true, via: 'window' })).not.toThrow();
      expect(announced).toHaveLength(1);
    });
  });

  describe('shutting down', () => {
    it('ends everything still open as exited and leaves no timers behind', () => {
      const onSettled = vi.fn();
      lifecycle.open(request('a', 'i-1'), { timeoutMs: 300_000, onSettled });
      lifecycle.open(request('b', 'i-2'));

      lifecycle.dispose();

      expect(announced.map((s) => s.end.reason)).toEqual(['exited', 'exited']);
      expect(onSettled).toHaveBeenCalledTimes(1);
      expect(lifecycle.list()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
