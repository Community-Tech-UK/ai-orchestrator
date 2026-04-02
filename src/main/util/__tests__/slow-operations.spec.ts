// src/main/util/__tests__/slow-operations.spec.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  measureAsync,
  measureOp,
  setSlowOpCallback,
  safeStringify,
  safeParse,
  getThreshold,
} from '../slow-operations';

describe('slow-operations', () => {
  beforeEach(() => {
    // Reset the global callback between tests
    setSlowOpCallback(null);
    vi.useFakeTimers();
  });

  afterEach(() => {
    setSlowOpCallback(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('measureAsync()', () => {
    it('returns the value from the wrapped function', async () => {
      const result = await measureAsync('test.op', async () => 42);
      expect(result).toBe(42);
    });

    it('propagates errors from the wrapped function', async () => {
      await expect(
        measureAsync('test.op', async () => { throw new Error('inner error'); })
      ).rejects.toThrow('inner error');
    });

    it('calls the slow-op callback when duration exceeds threshold', async () => {
      const cb = vi.fn();
      setSlowOpCallback(cb);

      await measureAsync('test.slow', async () => {
        vi.advanceTimersByTime(200);
        return 'done';
      }, 50);

      expect(cb).toHaveBeenCalledWith('test.slow', expect.any(Number), 50);
    });

    it('does not call the slow-op callback when duration is under threshold', async () => {
      const cb = vi.fn();
      setSlowOpCallback(cb);

      await measureAsync('test.fast', async () => 'ok', 500);

      expect(cb).not.toHaveBeenCalled();
    });

    it('uses the default threshold when none provided', async () => {
      const cb = vi.fn();
      setSlowOpCallback(cb);

      // 'default' threshold is 100ms — advance past it
      await measureAsync('unknown.op', async () => {
        vi.advanceTimersByTime(150);
        return 'result';
      });

      expect(cb).toHaveBeenCalled();
    });

    it('uses threshold from THRESHOLDS table for known op names', async () => {
      const cb = vi.fn();
      setSlowOpCallback(cb);

      // 'session.save' threshold is 200ms — advance to just under
      await measureAsync('session.save', async () => {
        vi.advanceTimersByTime(150);
        return 'saved';
      });

      // 150ms < 200ms threshold — should NOT fire
      expect(cb).not.toHaveBeenCalled();
    });

    it('fires for session.save when duration exceeds its 200ms threshold', async () => {
      const cb = vi.fn();
      setSlowOpCallback(cb);

      await measureAsync('session.save', async () => {
        vi.advanceTimersByTime(250);
        return 'saved';
      });

      expect(cb).toHaveBeenCalledWith('session.save', expect.any(Number), 200);
    });
  });

  describe('measureOp()', () => {
    it('returns a Disposable with a [Symbol.dispose] method', () => {
      const op = measureOp('test.op');
      expect(typeof op[Symbol.dispose]).toBe('function');
      op[Symbol.dispose]();
    });

    it('calls slow-op callback on dispose when slow', () => {
      const cb = vi.fn();
      setSlowOpCallback(cb);

      const op = measureOp('test.op', 50);
      vi.advanceTimersByTime(100);
      op[Symbol.dispose]();

      expect(cb).toHaveBeenCalledWith('test.op', expect.any(Number), 50);
    });

    it('does not call callback on dispose when fast', () => {
      const cb = vi.fn();
      setSlowOpCallback(cb);

      const op = measureOp('test.op', 500);
      op[Symbol.dispose]();

      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('setSlowOpCallback()', () => {
    it('accepts null to clear the callback', () => {
      const cb = vi.fn();
      setSlowOpCallback(cb);
      setSlowOpCallback(null);

      // Should not throw even after clearing
      expect(() => safeStringify({ a: 1 })).not.toThrow();
    });

    it('replaces the previous callback', async () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();

      setSlowOpCallback(cb1);
      setSlowOpCallback(cb2);

      await measureAsync('test.op', async () => {
        vi.advanceTimersByTime(200);
      }, 50);

      expect(cb1).not.toHaveBeenCalled();
      expect(cb2).toHaveBeenCalled();
    });
  });

  describe('safeStringify()', () => {
    it('returns a JSON string', () => {
      const result = safeStringify({ key: 'value' });
      expect(result).toBe('{"key":"value"}');
    });

    it('handles arrays', () => {
      expect(safeStringify([1, 2, 3])).toBe('[1,2,3]');
    });

    it('handles primitives', () => {
      expect(safeStringify(42)).toBe('42');
      expect(safeStringify('hello')).toBe('"hello"');
      expect(safeStringify(true)).toBe('true');
    });

    it('calls slow-op callback when stringify is slow', () => {
      const cb = vi.fn();
      setSlowOpCallback(cb);

      // Patch Date.now to simulate elapsed time
      let callCount = 0;
      const realNow = Date.now;
      vi.spyOn(Date, 'now').mockImplementation(() => {
        callCount++;
        return callCount === 1 ? 0 : 200; // First call: start, second call: end
      });

      safeStringify({ x: 1 });

      expect(cb).toHaveBeenCalledWith('json.stringify', expect.any(Number), 50);

      Date.now = realNow;
    });
  });

  describe('safeParse()', () => {
    it('parses a valid JSON string', () => {
      expect(safeParse('{"key":"value"}')).toEqual({ key: 'value' });
    });

    it('parses arrays', () => {
      expect(safeParse('[1,2,3]')).toEqual([1, 2, 3]);
    });

    it('parses primitives', () => {
      expect(safeParse('42')).toBe(42);
      expect(safeParse('"hello"')).toBe('hello');
    });

    it('throws on invalid JSON (preserving JSON.parse semantics)', () => {
      expect(() => safeParse('not-json')).toThrow();
    });
  });

  describe('getThreshold()', () => {
    it('returns known threshold for recognized op names', () => {
      expect(getThreshold('json.stringify')).toBe(50);
      expect(getThreshold('json.parse')).toBe(50);
      expect(getThreshold('context.compact')).toBe(500);
      expect(getThreshold('session.save')).toBe(200);
      expect(getThreshold('session.restore')).toBe(500);
      expect(getThreshold('embedding.generate')).toBe(1000);
      expect(getThreshold('snapshot.write')).toBe(300);
    });

    it('returns default threshold (100) for unknown names', () => {
      expect(getThreshold('some.unknown.operation')).toBe(100);
    });
  });
});
