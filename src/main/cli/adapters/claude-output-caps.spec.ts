import { describe, expect, it, vi } from 'vitest';
import { claudeOutputCapSettings, resolveClaudeBashOutputMaxChars } from './claude-output-caps';

describe('Claude successful command output cap', () => {
  it('resolves the configured cap and gives an explicit value priority', () => {
    const read = vi.fn(() => 12_000);
    expect(resolveClaudeBashOutputMaxChars(undefined, read)).toBe(12_000);
    expect(read).toHaveBeenCalledWith('claudeBashOutputMaxChars');
    expect(resolveClaudeBashOutputMaxChars(24_000)).toBe(24_000);
    expect(resolveClaudeBashOutputMaxChars(0)).toBeUndefined();
  });
  it.each([1, 3_999, 128_001, 12_000.5, NaN, Infinity, '12000'])('clamps a persisted unsupported value %s', cap => {
    const result = resolveClaudeBashOutputMaxChars(undefined, () => cap);
    if (typeof cap === 'number' && Number.isFinite(cap) && cap > 0) expect(result).toBe(Math.min(128_000, Math.max(4_000, Math.floor(cap))));
    else expect(result).toBeUndefined();
  });
  it('omits the cap when the settings manager is unavailable', () => {
    expect(resolveClaudeBashOutputMaxChars()).toBeUndefined();
  });
  it.each(['2.1.261', '2.1.296'])('emits only with confirmed support at %s', version => {
    expect(claudeOutputCapSettings(12_000, version)).toEqual({ bashOutputMaxChars: 12_000 });
  });
  it.each([null, '2.1.260', 'unknown'])('omits on unconfirmed support %s', version => {
    expect(claudeOutputCapSettings(12_000, version)).toEqual({});
  });
});
