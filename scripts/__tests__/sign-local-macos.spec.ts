import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const signer = require('../sign-local-macos.js') as {
  selectCodeSigningIdentity: (output: string) => { hash: string; name: string };
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
      timestamp: 'none',
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
      timestamp: 'none',
    });
  });
});
