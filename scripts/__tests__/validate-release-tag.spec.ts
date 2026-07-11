import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { validateReleaseTag } = require('../validate-release-tag.js') as {
  validateReleaseTag: (tag: string, version: string) => string[];
};

describe('validateReleaseTag', () => {
  it('accepts an exact stable semantic version tag', () => {
    expect(validateReleaseTag('v1.2.3', '1.2.3')).toEqual([]);
  });

  it('rejects malformed, prerelease, and version-mismatched tags', () => {
    expect(validateReleaseTag('1.2.3', '1.2.3')).not.toEqual([]);
    expect(validateReleaseTag('v1.2.3-beta.1', '1.2.3-beta.1')).not.toEqual([]);
    expect(validateReleaseTag('v1.2.4', '1.2.3')).toContain(
      'Tag v1.2.4 does not match package version 1.2.3',
    );
  });
});
