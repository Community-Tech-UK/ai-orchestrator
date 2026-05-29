import { describe, expect, it } from 'vitest';
import {
  compareSemverVersions,
  isUpdateAvailable,
  normalizeSemverVersion,
  parseSemver,
} from '../semver';

describe('compareSemverVersions', () => {
  const sign = (n: number): -1 | 0 | 1 => (n < 0 ? -1 : n > 0 ? 1 : 0);

  it('orders by major, then minor, then patch', () => {
    expect(sign(compareSemverVersions('1.0.0', '2.0.0'))).toBe(-1);
    expect(sign(compareSemverVersions('1.2.0', '1.1.9'))).toBe(1);
    expect(sign(compareSemverVersions('1.0.1', '1.0.2'))).toBe(-1);
    expect(sign(compareSemverVersions('1.0.0', '1.0.0'))).toBe(0);
  });

  it('handles real CLI version strings', () => {
    // claude-code style
    expect(sign(compareSemverVersions('2.1.100', '2.1.156'))).toBe(-1);
    // codex style (0.x)
    expect(sign(compareSemverVersions('0.134.0', '0.135.0'))).toBe(-1);
  });

  it('ignores a leading v', () => {
    expect(sign(compareSemverVersions('v1.0.0', '1.0.0'))).toBe(0);
    expect(sign(compareSemverVersions('v1.0.0', 'v2.0.0'))).toBe(-1);
  });

  it('treats two-segment versions as patch 0', () => {
    expect(sign(compareSemverVersions('1.2', '1.2.0'))).toBe(0);
    expect(sign(compareSemverVersions('1.2', '1.3.0'))).toBe(-1);
  });

  it('orders a prerelease below its release', () => {
    expect(sign(compareSemverVersions('1.0.0-beta', '1.0.0'))).toBe(-1);
    expect(sign(compareSemverVersions('1.0.0', '1.0.0-beta'))).toBe(1);
    expect(sign(compareSemverVersions('1.0.0-alpha', '1.0.0-beta'))).toBe(-1);
    expect(sign(compareSemverVersions('1.0.0-alpha.1', '1.0.0-alpha.2'))).toBe(-1);
  });

  it('falls back to localeCompare for unparseable input (total order, no throw)', () => {
    expect(() => compareSemverVersions('not-a-version', '1.0.0')).not.toThrow();
    expect(sign(compareSemverVersions('abc', 'abc'))).toBe(0);
  });
});

describe('parseSemver', () => {
  it('parses a normal version', () => {
    expect(parseSemver('1.2.3')).toMatchObject({ major: 1, minor: 2, patch: 3, prerelease: [] });
  });

  it('parses prerelease identifiers', () => {
    expect(parseSemver('1.2.3-rc.1')).toMatchObject({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: ['rc', '1'],
    });
  });

  it('returns null for non-numeric segments', () => {
    expect(parseSemver('1.x.0')).toBeNull();
    expect(parseSemver('')).toBeNull();
  });
});

describe('isUpdateAvailable', () => {
  it('is true only when latest is strictly newer than current', () => {
    expect(isUpdateAvailable('1.0.0', '2.0.0')).toBe(true);
    expect(isUpdateAvailable('1.0.0', '1.0.1')).toBe(true);
    expect(isUpdateAvailable('2.0.0', '1.0.0')).toBe(false);
    expect(isUpdateAvailable('1.0.0', '1.0.0')).toBe(false);
  });

  it('is false when either version is unknown', () => {
    expect(isUpdateAvailable(undefined, '2.0.0')).toBe(false);
    expect(isUpdateAvailable('1.0.0', undefined)).toBe(false);
    expect(isUpdateAvailable(null, null)).toBe(false);
    expect(isUpdateAvailable('1.0.0', '')).toBe(false);
  });
});

describe('normalizeSemverVersion', () => {
  it('pads a two-segment version', () => {
    expect(normalizeSemverVersion('1.2')).toBe('1.2.0');
  });

  it('preserves prerelease tags', () => {
    expect(normalizeSemverVersion('1.2-beta.1')).toBe('1.2.0-beta.1');
  });
});
