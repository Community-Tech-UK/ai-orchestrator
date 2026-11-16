import { afterEach, describe, expect, it } from 'vitest';
import { BrowserDeviceLoginCapability, getBrowserDeviceLoginCapability, isBrowserDeviceLoginGenerationCurrent,
  mintBrowserDeviceLoginCapability, setBrowserDeviceLoginCapabilityProvider, verifyBrowserDeviceLoginCapability } from './browser-device-login-capability';

afterEach(() => setBrowserDeviceLoginCapabilityProvider(null));
describe('device login caller capability', () => {
  it('rotates only one instance and returns a distinct trusted generation, never the token', () => {
    const capabilities = new BrowserDeviceLoginCapability(() => true);
    const first = capabilities.mint('first')!;
    const generation = capabilities.verify('first', first)!;
    expect(typeof generation).toBe('string');
    expect(generation).not.toBe(first);
    const other = capabilities.mint('other')!;
    const second = capabilities.mint('first')!;
    expect(capabilities.verify('first', first)).toBeNull();
    expect(capabilities.isCurrent('first', generation)).toBe(false);
    expect(capabilities.verify('first', second)).not.toBe(generation);
    expect(capabilities.verify('first', second)).not.toBeNull();
    expect(capabilities.verify('other', other)).not.toBeNull();
    expect(capabilities.verify('other', second)).toBeNull();
    expect(capabilities.get('first')).toBe(second);
  });
  it('never considers a missing owner current, including malformed generation input', () => {
    const capabilities = new BrowserDeviceLoginCapability(() => false);
    expect(capabilities.isCurrent('missing', undefined as never)).toBe(false);
  });
  it.each([undefined, null, '', 'PLACEHOLDER_WRONG_CAPABILITY', {}, 42])('rejects absent or invalid token %j', token => {
    const capabilities = new BrowserDeviceLoginCapability(() => true);
    capabilities.mint('first');
    expect(capabilities.verify('first', token)).toBeNull();
  });
  it('refuses unknown instances and erases entries when an owner disappears', () => {
    const known = new Set(['first']);
    const capabilities = new BrowserDeviceLoginCapability(id => known.has(id));
    expect(capabilities.mint('missing')).toBeNull();
    const token = capabilities.mint('first')!;
    known.delete('first');
    expect(capabilities.verify('first', token)).toBeNull();
    known.add('first');
    expect(capabilities.verify('first', token)).toBeNull();
  });
  it('bounds retained owners without evicting live capabilities and reclaims removed owners', () => {
    const known = new Set(Array.from({ length: 4097 }, (_, index) => `owner-${index}`));
    const capabilities = new BrowserDeviceLoginCapability(id => known.has(id));
    for (let index = 0; index < 4096; index++) expect(capabilities.mint(`owner-${index}`)).not.toBeNull();
    const preserved = capabilities.get('owner-1');
    expect(capabilities.mint('owner-4096')).toBeNull();
    expect(capabilities.verify('owner-1', preserved)).not.toBeNull();
    known.delete('owner-0');
    expect(capabilities.mint('owner-4096')).not.toBeNull();
    expect(capabilities.verify('owner-1', preserved)).not.toBeNull();
  });
  it('revokes entries explicitly and clears the provider on shutdown', () => {
    const capabilities = new BrowserDeviceLoginCapability(() => true);
    setBrowserDeviceLoginCapabilityProvider(capabilities);
    const token = mintBrowserDeviceLoginCapability('first')!;
    const generation = verifyBrowserDeviceLoginCapability('first', token)!;
    expect(getBrowserDeviceLoginCapability('first')).toBe(token);
    expect(isBrowserDeviceLoginGenerationCurrent('first', generation)).toBe(true);
    capabilities.revoke('first');
    expect(verifyBrowserDeviceLoginCapability('first', token)).toBeNull();
    const next = mintBrowserDeviceLoginCapability('first')!;
    setBrowserDeviceLoginCapabilityProvider(null);
    expect(capabilities.verify('first', next)).toBeNull();
    expect(mintBrowserDeviceLoginCapability('first')).toBeNull();
    expect(verifyBrowserDeviceLoginCapability('first', next)).toBeNull();
    expect(isBrowserDeviceLoginGenerationCurrent('first', generation)).toBe(false);
  });
});
