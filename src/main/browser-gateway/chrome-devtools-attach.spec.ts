import { describe, expect, it } from 'vitest';
import {
  MANAGED_DEBUG_HOST,
  deriveManagedDebugPort,
  resolveChromeDevtoolsBrowserUrl,
} from './chrome-devtools-attach';

describe('chrome-devtools-attach', () => {
  it('derives a deterministic port for a given profile id', () => {
    const a = deriveManagedDebugPort('profile-abc');
    const b = deriveManagedDebugPort('profile-abc');
    expect(a).toBe(b);
  });

  it('keeps derived ports within the [10000, 49999] band', () => {
    for (const id of ['a', 'profile-1', 'x'.repeat(64), 'apple-dev', '00000']) {
      const port = deriveManagedDebugPort(id);
      expect(port).toBeGreaterThanOrEqual(10_000);
      expect(port).toBeLessThanOrEqual(49_999);
      expect(Number.isInteger(port)).toBe(true);
    }
  });

  it('produces different ports for different profile ids', () => {
    const ports = new Set(
      ['p1', 'p2', 'p3', 'p4', 'p5'].map((id) => deriveManagedDebugPort(id)),
    );
    // Not a hard guarantee, but distinct small inputs should not all collide.
    expect(ports.size).toBeGreaterThan(1);
  });

  it('rejects an empty profile id', () => {
    expect(() => deriveManagedDebugPort('')).toThrow(/non-empty profileId/);
  });

  it('builds a localhost http browser URL matching the derived port', () => {
    const url = resolveChromeDevtoolsBrowserUrl('profile-abc');
    expect(url).toBe(`http://${MANAGED_DEBUG_HOST}:${deriveManagedDebugPort('profile-abc')}`);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d{5}$/);
  });
});
