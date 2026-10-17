import { describe, expect, it } from 'vitest';
import { normalizeOpenCodeAdditionalDirectories as normalize } from './opencode-additional-directories';

describe('OpenCode additional directories', () => {
  it('retains POSIX, Windows drive and UNC paths with independent array ownership', () => {
    const paths = ['/repo/shared', 'C:\\work\\shared', '\\\\worker\\share\\folder'];
    expect(normalize(paths, 'opencode')).toEqual(paths);
    expect(normalize(paths, 'opencode')).not.toBe(paths);
    expect(normalize(undefined, 'claude')).toBeUndefined();
    expect(normalize([], 'claude')).toEqual([]);
  });
  it.each([null, '/repo', ['relative'], ['C:relative'], ['/repo/*'], ['/repo/?'], ['/repo\0hidden'], [''], [42], new Array(1), Array(65).fill('/repo'), ['/' + 'a'.repeat(4096)]])('rejects invalid folder input %j', value => {
    expect(() => normalize(value, 'opencode')).toThrow(/absolute paths/);
  });
  it.each(['claude', 'codex', 'auto', undefined])('refuses folder access for provider %s', provider => {
    expect(() => normalize(['/repo'], provider)).toThrow(/OpenCode/);
  });
});
