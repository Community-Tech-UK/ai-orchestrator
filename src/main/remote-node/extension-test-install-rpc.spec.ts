import { describe, expect, it } from 'vitest';
import {
  BrowserExtensionTestParamsSchema,
  EXTENSION_TEST_MAX_BYTES,
  ExtensionTestRefusal,
  assertTestManifestAllowed,
  compareExtensionVersions,
  decodeExtensionTestBundle,
  isSafeExtensionFileName,
} from './extension-test-install-rpc';

const installed = {
  manifest_version: 3,
  version: '0.2.54',
  key: 'KEY',
  permissions: ['tabs', 'storage'],
  host_permissions: ['https://*/*'],
  background: { service_worker: 'background.js' },
};

function file(name: string, content = 'x') {
  return { name, contentBase64: Buffer.from(content).toString('base64') };
}

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof ExtensionTestRefusal) return error.code;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('extension test install rules', () => {
  it('compares dotted versions numerically', () => {
    expect(compareExtensionVersions('0.2.55', '0.2.54')).toBeGreaterThan(0);
    expect(compareExtensionVersions('0.2.9', '0.2.54')).toBeLessThan(0);
    expect(compareExtensionVersions('0.3', '0.3.0')).toBe(0);
  });

  it('refuses swapping which hosts reach which web accessible resource', () => {
    const base = {
      ...installed,
      web_accessible_resources: [
        { resources: ['a.js'], matches: ['https://a.example/*'] },
        { resources: ['b.js'], matches: ['https://b.example/*'] },
      ],
    };
    const swapped = {
      ...base,
      version: '0.2.55',
      web_accessible_resources: [
        { resources: ['a.js'], matches: ['https://b.example/*'] },
        { resources: ['b.js'], matches: ['https://a.example/*'] },
      ],
    };
    expect(refusal(() => assertTestManifestAllowed(swapped, base))).toBe('permissions_widened');
    const narrower = { ...base, version: '0.2.55', web_accessible_resources: [{ resources: ['a.js'], matches: ['https://a.example/*'] }] };
    expect(assertTestManifestAllowed(narrower, base).testVersion).toBe('0.2.55');
  });

  it('refuses moving an externally connectable value to another field', () => {
    const base = { ...installed, externally_connectable: { ids: ['abc'], matches: ['https://a.example/*'] } };
    const moved = { ...base, version: '0.2.55', externally_connectable: { ids: ['https://a.example/*'], matches: ['abc'] } };
    expect(refusal(() => assertTestManifestAllowed(moved, base))).toBe('permissions_widened');
  });

  it('accepts a higher version with equal or narrower access', () => {
    expect(assertTestManifestAllowed({ ...installed, version: '0.2.55', permissions: ['tabs'] }, installed))
      .toEqual({ testVersion: '0.2.55', originalVersion: '0.2.54' });
  });

  it.each([
    ['same version', { version: '0.2.54' }, 'version_not_above_installed'],
    ['lower version', { version: '0.2.53' }, 'version_not_above_installed'],
    ['wider permissions', { version: '0.2.55', permissions: ['tabs', 'history'] }, 'permissions_widened'],
    ['wider hosts', { version: '0.2.55', host_permissions: ['<all_urls>'] }, 'permissions_widened'],
    ['new content script', { version: '0.2.55', content_scripts: [{ matches: ['https://x/*'], js: ['a.js'] }] }, 'permissions_widened'],
    ['externally connectable', { version: '0.2.55', externally_connectable: { matches: ['https://x/*'] } }, 'permissions_widened'],
    ['another key', { version: '0.2.55', key: 'OTHER' }, 'manifest_identity_changed'],
    ['relaxed extension page policy', { version: '0.2.55', content_security_policy: { extension_pages: "script-src 'unsafe-eval'" } }, 'manifest_identity_changed'],
    ['another worker file', { version: '0.2.55', background: { service_worker: 'other.js' } }, 'manifest_identity_changed'],
    ['no version', { version: undefined }, 'manifest_invalid'],
  ])('refuses %s', (_label, change, code) => {
    expect(refusal(() => assertTestManifestAllowed({ ...installed, ...change }, installed))).toBe(code);
  });

  it.each(['../evil.js', 'a/b.js', 'a\\b.js', '.hidden.js', 'run.exe', 'noext', '..', 'x..y.js', 'dir/'])('rejects file name %s', (name) => {
    expect(isSafeExtensionFileName(name)).toBe(false);
  });

  it('decodes a bundle and requires a manifest, unique names and a size cap', () => {
    expect(decodeExtensionTestBundle([file('manifest.json', '{}'), file('background.js')]).map((f) => f.name))
      .toEqual(['manifest.json', 'background.js']);
    expect(refusal(() => decodeExtensionTestBundle([file('background.js')]))).toBe('manifest_missing');
    expect(refusal(() => decodeExtensionTestBundle([file('manifest.json'), file('Manifest.json')]))).toBe('file_name_refused');
    expect(refusal(() => decodeExtensionTestBundle([file('manifest.json'), file('../x.js')]))).toBe('file_name_refused');
    expect(refusal(() => decodeExtensionTestBundle([
      file('manifest.json'),
      file('big.js', 'a'.repeat(EXTENSION_TEST_MAX_BYTES + 1)),
    ]))).toBe('bundle_too_large');
  });

  it('keeps the lease length inside its bounds on the wire', () => {
    const base = { action: 'install', ownerId: 'a', files: [file('manifest.json')] };
    expect(BrowserExtensionTestParamsSchema.safeParse({ ...base, ttlMs: 60_000 }).success).toBe(true);
    expect(BrowserExtensionTestParamsSchema.safeParse({ ...base, ttlMs: 1000 }).success).toBe(false);
    expect(BrowserExtensionTestParamsSchema.safeParse({ ...base, ttlMs: 121 * 60_000 }).success).toBe(false);
    expect(BrowserExtensionTestParamsSchema.safeParse({ action: 'restore', ownerId: 'a', extra: 1 }).success).toBe(false);
  });
});
