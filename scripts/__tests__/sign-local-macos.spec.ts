import { createRequire } from 'node:module';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const signer = require('../sign-local-macos.js') as {
  findCodeSigningIdentity: (output: string) => { hash: string; name: string } | null;
  selectCodeSigningIdentity: (output: string) => { hash: string; name: string };
  findMachOBinaries: (rootDir: string) => string[];
  runCodesign: (args: string[], label: string) => void;
  adHocSignApp: (
    appPath: string,
    deps?: { runCodesign?: (args: string[], label: string) => void },
  ) => void;
  signWithLocalIdentity: (
    options: { app: string; platform: string; identity?: string },
    deps: {
      readIdentities: () => string;
      signApp: (options: Record<string, unknown>) => Promise<void>;
      verifyIdentity: (appPath: string) => void;
    },
  ) => Promise<void>;
  sign: unknown;
};

function writeCodeFile(filePath: string, magic: number, secondWord = 0) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const header = Buffer.alloc(8);
  header.writeUInt32BE(magic, 0);
  header.writeUInt32BE(secondWord, 4);
  writeFileSync(filePath, header);
}

describe('local macOS signer', () => {
  it('provides identity selection and signing entry points', () => {
    expect(signer.selectCodeSigningIdentity).toBeTypeOf('function');
    expect(signer.signWithLocalIdentity).toBeTypeOf('function');
    expect(signer.sign).toBeTypeOf('function');
  });

  it('prefers Developer ID and otherwise accepts Apple Development', () => {
    const appleDevelopment = [
      '  1) AAA111 "Apple Development: Local Developer (TEAM123456)"',
      '     1 valid identities found',
    ].join('\n');
    expect(signer.selectCodeSigningIdentity(appleDevelopment)).toEqual({
      hash: 'AAA111',
      name: 'Apple Development: Local Developer (TEAM123456)',
    });

    const withDeveloperId = [
      '  1) AAA111 "Apple Development: Local Developer (TEAM123456)"',
      '  2) BBB222 "Developer ID Application: Release Developer (TEAM123456)"',
      '     2 valid identities found',
    ].join('\n');
    expect(signer.selectCodeSigningIdentity(withDeveloperId)).toEqual({
      hash: 'BBB222',
      name: 'Developer ID Application: Release Developer (TEAM123456)',
    });
  });

  it('fails clearly when no real code-signing identity is installed', () => {
    expect(() => signer.selectCodeSigningIdentity('0 valid identities found'))
      .toThrow('A real macOS code-signing identity is required for localbuild');
  });

  it('signs the complete app with the selected identity and verifies ownership', async () => {
    const signApp = vi.fn(async () => undefined);
    const verifyIdentity = vi.fn();
    const options = { app: '/tmp/Harness.app', platform: 'darwin' };

    await signer.signWithLocalIdentity(options, {
      readIdentities: () =>
        '1) AAA111 "Apple Development: Local Developer (TEAM123456)"',
      signApp,
      verifyIdentity,
    });

    expect(signApp).toHaveBeenCalledExactlyOnceWith({
      ...options,
      identity: 'AAA111',
    });
    expect(verifyIdentity).toHaveBeenCalledExactlyOnceWith('/tmp/Harness.app');
  });

  it('preserves the release identity already selected by electron-builder', async () => {
    const signApp = vi.fn(async () => undefined);

    await signer.signWithLocalIdentity({
      app: '/tmp/Harness.app',
      platform: 'darwin',
      identity: 'RELEASE-CERTIFICATE-HASH',
    }, {
      readIdentities: () => { throw new Error('must not discover a second identity'); },
      signApp,
      verifyIdentity: vi.fn(),
    });

    expect(signApp).toHaveBeenCalledExactlyOnceWith({
      app: '/tmp/Harness.app',
      platform: 'darwin',
      identity: 'RELEASE-CERTIFICATE-HASH',
    });
  });

  it('finds no identity when none is installed, without throwing', () => {
    expect(signer.findCodeSigningIdentity('0 valid identities found')).toBeNull();
    expect(signer.findCodeSigningIdentity('not a security listing')).toBeNull();
    expect(
      signer.findCodeSigningIdentity('  1) AAA111 "Apple Development: Local Developer (TEAM123456)"'),
    ).toEqual({ hash: 'AAA111', name: 'Apple Development: Local Developer (TEAM123456)' });
  });

  it('finds Mach-O binaries anywhere in a bundle and skips other files', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'sign-local-macos-'));
    try {
      writeCodeFile(path.join(root, 'Contents/MacOS/Harness'), 0xfeedfacf);
      writeCodeFile(path.join(root, 'Contents/MacOS/universal'), 0xcafebabf, 2);
      writeCodeFile(
        path.join(root, 'Contents/Resources/app.asar.unpacked/better_sqlite3.node'),
        0xcffaedfe,
      );
      writeCodeFile(path.join(root, 'Contents/Resources/prebuilds/win32-arm64/pty.node'), 0x90909090);
      // Java class files share the fat Mach-O magic; the version word that
      // follows is what tells them apart.
      writeCodeFile(path.join(root, 'Contents/Resources/Widget.class'), 0xcafebabe, 0x00000034);
      writeFileSync(path.join(root, 'Contents/Resources/app.asar'), 'not code');

      const found = signer.findMachOBinaries(root)
        .map((file) => path.relative(root, file))
        .sort();

      expect(found).toEqual([
        'Contents/MacOS/Harness',
        'Contents/MacOS/universal',
        'Contents/Resources/app.asar.unpacked/better_sqlite3.node',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails loudly when a file in the bundle cannot be read', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'sign-local-macos-'));
    const unreadable = path.join(root, 'Contents/MacOS/Harness');
    try {
      writeCodeFile(unreadable, 0xfeedfacf);
      chmodSync(unreadable, 0o000);
      expect(() => signer.findMachOBinaries(root)).toThrow();
    } finally {
      chmodSync(unreadable, 0o600);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('maps codesign failures to a thrown error', () => {
    expect(() => signer.runCodesign(
      ['--verify', '--deep', '--strict', '/no/such/Harness.app'],
      'Signature verification',
    )).toThrow(/^Signature verification failed/);
  });

  it('ad-hoc signs loose binaries before the bundle and verifies afterwards', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'sign-local-macos-'));
    try {
      const app = path.join(root, 'Harness.app');
      const nativeModule = path.join(app, 'Contents/Resources/app.asar.unpacked/pty.node');
      writeCodeFile(nativeModule, 0xfeedfacf);
      const calls: string[][] = [];

      signer.adHocSignApp(app, {
        runCodesign: (args) => { calls.push(args); },
      });

      expect(calls).toEqual([
        ['--force', '--sign', '-', nativeModule],
        ['--force', '--deep', '--sign', '-', app],
        ['--verify', '--deep', '--strict', app],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
