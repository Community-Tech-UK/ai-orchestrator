import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
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
  it('ships the Apache licence beside every pinned 0.52.0 binary', () => {
    const manifest = JSON.parse(readFileSync(join(root, pinPaths[1]), 'utf8'));
    expect(manifest.version).toBe('0.52.0');
    const license = readFileSync(join(root, 'scripts/licenses/rtk-0.52.0-LICENSE'), 'utf8');
    expect(license).toContain('Apache License');
    for (const [target, hash] of Object.entries(manifest.hashes)) {
      const dir = join(root, 'resources/rtk', target);
      const binary = readFileSync(join(dir, target.startsWith('win32') ? 'rtk.exe' : 'rtk'));
      expect(createHash('sha256').update(binary).digest('hex'), target).toBe(hash);
      expect(readFileSync(join(dir, 'LICENSE'), 'utf8'), target).toBe(license);
    }
    expect(Object.keys(manifest.hashes)).toHaveLength(5);
  });
  it('packages the licence alongside the binary on every release platform', () => {
    const config = JSON.parse(readFileSync(join(root, 'electron-builder.json'), 'utf8'));
    for (const platform of ['mac', 'linux', 'win']) {
      const entry = config[platform].extraResources.find((resource: { from: string }) => resource.from.startsWith('resources/rtk/'));
      expect(entry, platform).toBeDefined();
      expect(entry.filter, platform).toContain('LICENSE');
    }
  });
  it('restores licences on the cached-binary path and fails if the licence source is missing', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'aio-rtk-license-'));
    try {
      mkdirSync(join(scratch, 'scripts/licenses'), { recursive: true });
      writeFileSync(join(scratch, pinPaths[0]), readFileSync(join(root, pinPaths[0])));
      const manifest = JSON.parse(readFileSync(join(root, pinPaths[1]), 'utf8'));
      const binary = 'obvious test placeholder';
      const hash = createHash('sha256').update(binary).digest('hex');
      for (const target of Object.keys(manifest.hashes)) {
        manifest.hashes[target] = hash;
        const dir = join(scratch, 'resources/rtk', target);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, target.startsWith('win32') ? 'rtk.exe' : 'rtk'), binary);
      }
      writeFileSync(join(scratch, pinPaths[1]), JSON.stringify(manifest));
      const licencePath = join(scratch, 'scripts/licenses/rtk-0.52.0-LICENSE');
      writeFileSync(licencePath, readFileSync(join(root, 'scripts/licenses/rtk-0.52.0-LICENSE')));
      const run = () => spawnSync(process.execPath, [join(scratch, pinPaths[0])], {
        encoding: 'utf8', env: { ...process.env, FETCH_RTK_SKIP: '0' },
      });
      expect(run().status).toBe(0);
      for (const target of Object.keys(manifest.hashes)) {
        expect(readFileSync(join(scratch, 'resources/rtk', target, 'LICENSE'), 'utf8')).toContain('Apache License');
      }
      rmSync(licencePath);
      expect(run().status).toBe(1);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
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
