import { describe, expect, it, vi } from 'vitest';
import { runAssertPersisted } from './browser-assert-persisted-operation';

describe('runAssertPersisted', () => {
  it('verifies persistence via signal scan + matching read-backs', async () => {
    const result = await runAssertPersisted({
      scan: async () => ({ state: 'ok', checkedAt: 1 }),
      readControl: async () => ({ value: 'Fast Local Service' }),
    }, [{ selector: '#headline', value: 'Fast Local Service' }]);

    expect(result).toEqual({
      persisted: true,
      confidence: 'verified',
      signalState: 'ok',
      checkedExpectations: 1,
      mismatches: [],
    });
  });

  it('fails when the app reports a save failure even if the DOM reads back fine', async () => {
    const result = await runAssertPersisted({
      scan: async () => ({
        state: 'save_failed',
        matchedPattern: 'changes failed to save',
        checkedAt: 1,
      }),
      readControl: async () => ({ value: 'Fast Local Service' }),
    }, [{ selector: '#headline', value: 'Fast Local Service' }]);

    expect(result.persisted).toBe(false);
    expect(result.signalState).toBe('save_failed');
    expect(result.matchedPattern).toBe('changes failed to save');
    expect(result.mismatches).toEqual([]);
  });

  it('reports read-back mismatches and missing controls', async () => {
    const readControl = vi.fn()
      .mockResolvedValueOnce({ value: 'wrong' })
      .mockResolvedValueOnce(null);
    const result = await runAssertPersisted({
      scan: async () => ({ state: 'ok', checkedAt: 1 }),
      readControl,
    }, [
      { selector: '#a', value: 'right' },
      { selector: '#b', checked: true },
    ]);

    expect(result.persisted).toBe(false);
    expect(result.mismatches).toEqual([
      { selector: '#a', mismatch: 'browser_verify_mismatch:value' },
      { selector: '#b', mismatch: 'control_not_found' },
    ]);
  });

  it('marks the verdict weak when neither scan nor read-backs could verify', async () => {
    const result = await runAssertPersisted({
      scan: async () => ({ state: 'unknown', checkedAt: 1 }),
      readControl: async () => null,
    }, []);

    expect(result).toMatchObject({ persisted: true, confidence: 'weak', signalState: 'unknown' });
  });

  it('treats read failures as mismatches instead of throwing', async () => {
    const result = await runAssertPersisted({
      scan: async () => ({ state: 'ok', checkedAt: 1 }),
      readControl: async () => {
        throw new Error('browser_extension_command_timeout');
      },
    }, [{ selector: '#a', value: 'x' }]);

    expect(result.persisted).toBe(false);
    expect(result.mismatches[0].mismatch).toContain('read_failed');
  });

  it('skips expectations with no expected fields', async () => {
    const readControl = vi.fn();
    const result = await runAssertPersisted({
      scan: async () => ({ state: 'ok', checkedAt: 1 }),
      readControl,
    }, [{ selector: '#a' }]);

    expect(readControl).not.toHaveBeenCalled();
    expect(result.checkedExpectations).toBe(0);
  });
});
