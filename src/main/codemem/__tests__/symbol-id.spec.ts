import { describe, expect, it } from 'vitest';
import { symbolId } from '../symbol-id';

describe('symbolId', () => {
  it('produces a stable SHA-1 hex of 40 chars', () => {
    const id = symbolId({
      absPath: '/repo/a.ts',
      kind: 'function',
      name: 'foo',
      containerName: null,
    });
    expect(id).toMatch(/^[a-f0-9]{40}$/);
  });

  it('is deterministic across calls', () => {
    const args = {
      absPath: '/repo/a.ts',
      kind: 'method',
      name: 'bar',
      containerName: 'Baz',
    } as const;
    expect(symbolId(args)).toBe(symbolId(args));
  });

  it('differs when containerName differs (null vs string)', () => {
    expect(symbolId({
      absPath: '/x.ts',
      kind: 'method',
      name: 'foo',
      containerName: null,
    })).not.toBe(symbolId({
      absPath: '/x.ts',
      kind: 'method',
      name: 'foo',
      containerName: 'A',
    }));
  });

  it('differs when kind differs', () => {
    expect(symbolId({
      absPath: '/x.ts',
      kind: 'function',
      name: 'foo',
      containerName: null,
    })).not.toBe(symbolId({
      absPath: '/x.ts',
      kind: 'method',
      name: 'foo',
      containerName: null,
    }));
  });
});
