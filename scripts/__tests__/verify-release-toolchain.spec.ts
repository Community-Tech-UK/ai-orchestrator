import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { validateReleaseToolchain } = require('../verify-release-toolchain.js') as {
  validateReleaseToolchain: (
    packages: Record<string, { version?: string }>,
  ) => string[];
};

describe('validateReleaseToolchain', () => {
  it('accepts every locked AppImage builder at or above the patched minimum', () => {
    expect(validateReleaseToolchain({
      'node_modules/app-builder-lib': { version: '26.15.0' },
      'node_modules/example/node_modules/app-builder-lib': { version: '26.15.7' },
    })).toEqual([]);
  });

  it('rejects missing, malformed, or vulnerable AppImage builders', () => {
    expect(validateReleaseToolchain({ })).toContain(
      'package-lock.json does not contain app-builder-lib',
    );
    expect(validateReleaseToolchain({
      'node_modules/app-builder-lib': { version: '26.14.9' },
    })).toContain(
      'node_modules/app-builder-lib locks vulnerable app-builder-lib 26.14.9; require >=26.15.0',
    );
    expect(validateReleaseToolchain({
      'node_modules/app-builder-lib': { version: 'invalid' },
    })).toContain(
      'node_modules/app-builder-lib has an invalid app-builder-lib version: invalid',
    );
  });
});
