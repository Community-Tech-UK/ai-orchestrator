import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { mergeUpdateManifestObjects } = require('../merge-update-manifests.js') as {
  mergeUpdateManifestObjects: (
    manifests: Array<{ version: string; files: Array<{ url: string; sha512: string }> }>,
  ) => { version: string; files: Array<{ url: string; sha512: string }> };
};

describe('mergeUpdateManifestObjects', () => {
  it('combines architecture payloads without losing either checksum', () => {
    const merged = mergeUpdateManifestObjects([
      { version: '1.2.3', files: [{ url: 'Harness-1.2.3-mac-arm64.zip', sha512: 'arm' }] },
      { version: '1.2.3', files: [{ url: 'Harness-1.2.3-mac-x64.zip', sha512: 'intel' }] },
    ]);

    expect(merged.files).toEqual([
      { url: 'Harness-1.2.3-mac-arm64.zip', sha512: 'arm' },
      { url: 'Harness-1.2.3-mac-x64.zip', sha512: 'intel' },
    ]);
  });

  it('rejects version drift between matrix artifacts', () => {
    expect(() => mergeUpdateManifestObjects([
      { version: '1.2.3', files: [{ url: 'arm.zip', sha512: 'arm' }] },
      { version: '1.2.4', files: [{ url: 'intel.zip', sha512: 'intel' }] },
    ])).toThrow('same version');
  });
});
