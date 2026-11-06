import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const hook = require('../set-electron-fuses.js') as {
  packagedExecutablePath: (context: {
    electronPlatformName: string;
    appOutDir: string;
    packager: { executableName?: string; appInfo: { productName: string } };
  }) => string | null;
};

const context = (electronPlatformName: string, executableName?: string) => ({
  electronPlatformName,
  appOutDir: '/out',
  packager: { executableName, appInfo: { productName: 'Harness' } },
});

describe('set-electron-fuses', () => {
  it('finds the Linux binary by the name electron-builder gave it, not the product name', () => {
    expect(hook.packagedExecutablePath(context('linux', 'harness'))).toBe(path.join('/out', 'harness'));
  });

  it('finds the binary inside the macOS app bundle', () => {
    expect(hook.packagedExecutablePath(context('darwin'))).toBe(
      path.join('/out', 'Harness.app', 'Contents', 'MacOS', 'Harness'),
    );
  });

  it('finds the Windows executable', () => {
    expect(hook.packagedExecutablePath(context('win32'))).toBe(path.join('/out', 'Harness.exe'));
  });

  it('skips a platform it does not know', () => {
    expect(hook.packagedExecutablePath(context('freebsd'))).toBeNull();
  });
});
