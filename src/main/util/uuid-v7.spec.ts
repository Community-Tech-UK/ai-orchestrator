import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetUuidv7ForTesting, uuidv7 } from './uuid-v7';

describe('uuidv7', () => {
  beforeEach(() => {
    resetUuidv7ForTesting();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetUuidv7ForTesting();
  });

  it('returns a canonical lowercase UUIDv7 with the millisecond timestamp prefix', () => {
    const now = 1_717_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const id = uuidv7();
    const compact = id.replace(/-/g, '');

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(compact.slice(0, 12)).toBe(now.toString(16).padStart(12, '0'));
  });

  it('sorts lexically in generation order for ids created during the same millisecond', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_717_000_000_001);

    const ids = Array.from({ length: 128 }, () => uuidv7());

    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });

  it('keeps lexical ordering when the system clock moves backward', () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValueOnce(1_717_000_000_010);
    now.mockReturnValueOnce(1_717_000_000_009);
    now.mockReturnValueOnce(1_717_000_000_008);

    const ids = [uuidv7(), uuidv7(), uuidv7()];

    expect([...ids].sort()).toEqual(ids);
  });

  it('resetUuidv7ForTesting clears monotonic clock state', () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValueOnce(1_717_000_000_020);
    uuidv7();

    resetUuidv7ForTesting();
    const afterResetNow = 1_717_000_000_000;
    now.mockReturnValueOnce(afterResetNow);
    const idAfterReset = uuidv7();

    expect(idAfterReset.replace(/-/g, '').slice(0, 12)).toBe(
      afterResetNow.toString(16).padStart(12, '0'),
    );
  });
});
