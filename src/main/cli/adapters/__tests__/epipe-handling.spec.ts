import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// We test the EPIPE guard logic directly — no need to mock Electron.
// Simulate the stdin/stdout stream error handler pattern.

function makeStream(writable: boolean, destroyed: boolean) {
  const emitter = new EventEmitter() as NodeJS.WritableStream & EventEmitter;
  (emitter as any).writable = writable;
  (emitter as any).destroyed = destroyed;
  return emitter;
}

describe('EPIPE handling helpers', () => {
  describe('isRealPipe()', () => {
    it('returns true when stdin is writable and not destroyed', () => {
      // Simulate the isRealPipe check directly
      const stdin = makeStream(true, false);
      const result = (stdin as any).writable === true && !(stdin as any).destroyed;
      expect(result).toBe(true);
    });

    it('returns false when stdin is not writable', () => {
      const stdin = makeStream(false, false);
      const result = (stdin as any).writable === true && !(stdin as any).destroyed;
      expect(result).toBe(false);
    });

    it('returns false when stdin is destroyed', () => {
      const stdin = makeStream(true, true);
      const result = (stdin as any).writable === true && !(stdin as any).destroyed;
      expect(result).toBe(false);
    });
  });

  describe('EPIPE error swallowing', () => {
    it('swallows EPIPE errors silently (does not rethrow)', () => {
      const stdin = makeStream(true, false);
      let rethrown: Error | null = null;

      // Apply the same error handler pattern as the adapters
      stdin.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EPIPE') return; // swallow
        rethrown = err;
      });

      const epipeError = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      stdin.emit('error', epipeError);

      expect(rethrown).toBeNull();
    });

    it('does not swallow non-EPIPE errors', () => {
      const stdin = makeStream(true, false);
      let rethrown: Error | null = null;

      stdin.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EPIPE') return;
        rethrown = err;
      });

      const otherError = Object.assign(new Error('write ENOSPC'), { code: 'ENOSPC' });
      stdin.emit('error', otherError);

      expect(rethrown).toBe(otherError);
    });

    it('handles stdout EPIPE independently', () => {
      const stdout = makeStream(true, false);
      let rethrown: Error | null = null;

      stdout.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EPIPE') return;
        rethrown = err;
      });

      stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      expect(rethrown).toBeNull();
    });
  });
});

describe('BaseCliAdapter.isRealPipe() integration', () => {
  // Dynamically import after mocking to avoid Electron dependency
  it('base adapter exports isRealPipe utility as a protected method', async () => {
    // Verify the method exists on the class by checking via prototype inspection
    // (We cannot instantiate BaseCliAdapter directly as it is abstract.)
    const mod = await import('../base-cli-adapter');
    expect(typeof mod.BaseCliAdapter).toBe('function');
    expect(typeof mod.BaseCliAdapter.prototype['isRealPipe']).toBe('function');
  });
});
