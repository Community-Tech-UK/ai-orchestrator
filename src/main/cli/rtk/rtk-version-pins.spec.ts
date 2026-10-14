import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const pinPaths = ['scripts/fetch-rtk-binaries.js', 'scripts/rtk-binaries.sha256.json', 'src/main/cli/rtk/rtk-runtime.ts'] as const;
function assertPinsAgree(root: string): void {
  const files = pinPaths.map(file => readFileSync(join(root, file), 'utf8'));
  const versions = [files[0].match(/const RTK_VERSION = '([^']+)'/)?.[1], JSON.parse(files[1]).version,
    files[2].match(/export const RTK_BUNDLED_VERSION = '([^']+)'/)?.[1]];
  for (let index = 0; index < versions.length; index++) {
    if (!versions[index] || versions[index] !== versions[0]) throw new Error(`RTK version pin disagrees: ${pinPaths[index]}`);
  }
}

describe('RTK bundled version pins', () => {
  const root = resolve(__dirname, '../../../..');
  it('the three repository pins agree', () => { expect(() => assertPinsAgree(root)).not.toThrow(); });
  it('a partial bump fails and names the mismatched file', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'aio-rtk-pins-'));
    try {
      for (const file of pinPaths) {
        mkdirSync(dirname(join(scratch, file)), { recursive: true });
        writeFileSync(join(scratch, file), readFileSync(join(root, file)));
      }
      const manifest = JSON.parse(readFileSync(join(scratch, pinPaths[1]), 'utf8'));
      manifest.version = 'STUB_PARTIAL_BUMP';
      writeFileSync(join(scratch, pinPaths[1]), JSON.stringify(manifest));
      expect(() => assertPinsAgree(scratch)).toThrow(pinPaths[1]);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
});
