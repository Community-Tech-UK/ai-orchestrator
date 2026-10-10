import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const hook = require('../localbuild-after-pack.js') as {
  (context: { appOutDir: string }): Promise<void>;
  afterPackImpl: (
    context: { appOutDir: string },
    deps: {
      setElectronFuses?: (context: unknown) => Promise<void>;
      adHocSign?: (appPath: string) => void;
      findAppBundle?: (appOutDir: string) => string;
    },
  ) => Promise<void>;
  findAppBundle: (appOutDir: string) => string;
};

describe('localbuild afterPack hook', () => {
  it('flips the Electron fuses before ad-hoc signing', async () => {
    const order: string[] = [];

    await hook.afterPackImpl({ appOutDir: '/tmp/release/mac-arm64' }, {
      setElectronFuses: async () => { order.push('fuses'); },
      adHocSign: () => { order.push('sign'); },
      findAppBundle: () => '/tmp/release/mac-arm64/Harness.app',
    });

    expect(order).toEqual(['fuses', 'sign']);
  });

  it('ad-hoc signs the app bundle found in the pack output', async () => {
    const appOutDir = mkdtempSync(path.join(tmpdir(), 'localbuild-after-pack-'));
    try {
      mkdirSync(path.join(appOutDir, 'Harness.app'));
      const adHocSign = vi.fn();

      await hook.afterPackImpl({ appOutDir }, {
        setElectronFuses: async () => undefined,
        adHocSign,
        findAppBundle: hook.findAppBundle,
      });

      expect(adHocSign).toHaveBeenCalledExactlyOnceWith(path.join(appOutDir, 'Harness.app'));
    } finally {
      rmSync(appOutDir, { recursive: true, force: true });
    }
  });

  it('fails clearly when the pack output does not hold exactly one app bundle', () => {
    const appOutDir = mkdtempSync(path.join(tmpdir(), 'localbuild-after-pack-'));
    try {
      expect(() => hook.findAppBundle(appOutDir))
        .toThrow(`Expected exactly one .app bundle in ${appOutDir}, found 0`);

      mkdirSync(path.join(appOutDir, 'Harness.app'));
      mkdirSync(path.join(appOutDir, 'Other.app'));
      expect(() => hook.findAppBundle(appOutDir))
        .toThrow(`Expected exactly one .app bundle in ${appOutDir}, found 2`);
    } finally {
      rmSync(appOutDir, { recursive: true, force: true });
    }
  });

  it('does not sign anything when the fuse step fails', async () => {
    const adHocSign = vi.fn();

    await expect(hook.afterPackImpl({ appOutDir: '/tmp/release/mac-arm64' }, {
      setElectronFuses: async () => { throw new Error('fuse flipping failed'); },
      adHocSign,
      findAppBundle: () => '/tmp/release/mac-arm64/Harness.app',
    })).rejects.toThrow('fuse flipping failed');

    expect(adHocSign).not.toHaveBeenCalled();
  });

  it('propagates ad-hoc signing failures out of the hook', async () => {
    await expect(hook.afterPackImpl({ appOutDir: '/tmp/release/mac-arm64' }, {
      setElectronFuses: async () => undefined,
      adHocSign: () => { throw new Error('Ad-hoc signing /tmp/app failed'); },
      findAppBundle: () => '/tmp/release/mac-arm64/Harness.app',
    })).rejects.toThrow('Ad-hoc signing /tmp/app failed');
  });
});
