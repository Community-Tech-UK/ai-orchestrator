import { describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import type { Browser } from 'puppeteer-core';
import { PuppeteerBrowserDriver } from './puppeteer-browser-driver';
import { BrowserTargetRegistry } from './browser-target-registry';
import { makeProfile, makeService, makeTarget } from './browser-gateway-service.test-helpers';
import { CredentialVaultError } from './browser-credential-vault';

const origin = 'http://localhost:4567';
const placeholder = 'TEST_ONLY_PASSWORD_PLACEHOLDER';

async function managed(options: { shadow?: boolean; contentEditable?: boolean } = {}) {
  let url = `${origin}/login`;
  let pageOrigin = origin;
  const field = { tagName: 'INPUT', type: 'password', value: '', textContent: '', isContentEditable: options.contentEditable, dispatchEvent: vi.fn() };
  const page = {
    url: () => url, title: async () => 'Test login',
    type: vi.fn(async (_selector: string, value: string) => { field.value = value; }),
    evaluate: vi.fn(async (fn: (input: unknown) => unknown, input: unknown) => runInNewContext(`(${fn.toString()})(input)`, {
      input, __name: (value: unknown) => value,
      location: { origin: pageOrigin },
      document: { querySelector: () => options.shadow ? null : field, querySelectorAll: () => options.shadow ? [{ shadowRoot: { querySelector: () => field, querySelectorAll: () => [] } }] : [], documentElement: {}, title: 'Test login' },
      InputEvent: class {}, Event: class {},
    })),
  };
  const driver = new PuppeteerBrowserDriver({
    launcher: { launchProfile: vi.fn(), getBrowser: () => ({ pages: async () => [page] }) as unknown as Browser, closeProfile: vi.fn() },
    targetRegistry: new BrowserTargetRegistry(), antiThrottle: false,
  });
  const [target] = await driver.openProfile(makeProfile({ userDataDir: '/tmp/test-only-browser-profile' }));
  const vault = { getSecretForFill: vi.fn(async () => placeholder), createAgentCredential: vi.fn(), getGenericSecretForFill: vi.fn() };
  const h = makeService({ target: makeTarget({ id: target.id }), credentialVault: vault, credentialAuthorizations: { check: () => ({ authorized: true }) } });
  h.driver.type.mockImplementation(async (...args: unknown[]) => { await driver.type(...args as Parameters<PuppeteerBrowserDriver['type']>); return undefined; });
  h.driver.refreshTarget.mockImplementation(() => driver.refreshTarget('profile-1', target.id));
  const request = { profileId: 'profile-1', targetId: target.id, instanceId: 'instance-1', vaultItemRef: 'test-item', fields: [{ selector: '#password', kind: 'password' as const }] };
  return { ...h, driver, page, field, vault, request,
    navigate: (next: string) => { url = next; pageOrigin = new URL(next).origin; },
    changePageOrigin: (next: string) => { pageOrigin = next; },
  };
}

describe('credential dispatch boundaries', () => {
  it('refuses a managed page that navigates after the secret was resolved', async () => {
    const h = await managed();
    h.vault.getSecretForFill.mockImplementationOnce(async () => { h.navigate('https://other.example.test/login'); return placeholder; });
    const result = await h.service.fillCredential(h.request);
    expect(result.decision).toBe('denied');
    expect(h.field.value).toBe('');
    expect(h.page.type).not.toHaveBeenCalled();
    expect(JSON.stringify({ result, audit: h.audits })).not.toContain(placeholder);
  });

  it('checks the actual page origin atomically even when the cached page URL still matches', async () => {
    const h = await managed();
    h.vault.getSecretForFill.mockImplementationOnce(async () => { h.changePageOrigin('https://other.example.test'); return placeholder; });
    expect((await h.service.fillCredential(h.request)).decision).toBe('denied');
    expect(h.field.value).toBe('');
    expect(h.page.type).not.toHaveBeenCalled();
  });

  it('fills the managed page through the bridge without returning the password', async () => {
    const h = await managed();
    const result = await h.service.fillCredential(h.request);
    expect(result).toMatchObject({ decision: 'allowed', outcome: 'succeeded', data: { filled: 1 } });
    expect(h.field.value).toBe(placeholder);
    expect(h.page.type).not.toHaveBeenCalled();
    await expect(h.page.evaluate.mock.results.at(-1)?.value).resolves.toBeUndefined();
    expect(JSON.stringify({ result, audit: h.audits })).not.toContain(placeholder);
  });

  it('preserves open-shadow selectors and contenteditable filling on the secure branch', async () => {
    const h = await managed({ shadow: true, contentEditable: true });
    expect((await h.service.fillCredential(h.request)).decision).toBe('allowed');
    expect(h.field.textContent).toBe(placeholder);
    expect(h.page.type).not.toHaveBeenCalled();
    await expect(h.page.evaluate.mock.results.at(-1)?.value).resolves.toBeUndefined();
  });

  it('runs the final guard immediately before the managed page command', async () => {
    const h = await managed();
    const beforeDispatch = () => { throw new CredentialVaultError('Vault is locked', 'vault_locked'); };
    await expect(h.driver.type('profile-1', h.request.targetId, '#password', placeholder, origin, beforeDispatch)).rejects.toMatchObject({ code: 'vault_locked' });
    expect(h.page.evaluate).not.toHaveBeenCalled();
    expect(h.page.type).not.toHaveBeenCalled();
    expect(h.field.value).toBe('');
  });

  it('does not dispatch a shared-tab password when the vault locks during the persistence scan', async () => {
    let locked = false;
    let scanStarted!: () => void;
    let finishScan!: () => void;
    const begun = new Promise<void>((resolve) => { scanStarted = resolve; });
    const scan = vi.fn(async () => {
      scanStarted(); await new Promise<void>((resolve) => { finishScan = resolve; });
      return { state: 'ok' as const, checkedAt: 1 };
    });
    const tab = { profileId: 'existing-tab:7:42', targetId: 'existing-tab:7:42:target', url: `${origin}/login`, origin, title: 'Test login', allowedOrigins: [{ scheme: 'http' as const, hostPattern: 'localhost', port: 4567, includeSubdomains: false }] };
    const sendCommand = vi.fn(async (request: { command: string }) => request.command === 'snapshot'
      ? { tab: { tabId: 42, windowId: 7, url: tab.url } }
      : { completed: true, observationBlocked: 'browser_secret_observation_blocked_for_tainted_origin' });
    const vault = {
      getSecretForFill: async () => placeholder, createAgentCredential: vi.fn(), getGenericSecretForFill: vi.fn(),
      captureFillGuard: () => () => { if (locked) throw new CredentialVaultError('Vault is locked', 'vault_locked'); },
    };
    const h = makeService({
      existingTab: tab, extensionCommandStore: { sendCommand }, allowSharedTabCredentialFill: () => true,
      persistenceSentinel: { scan, needsPreWriteCheck: () => true, forgetTarget: vi.fn() },
      credentialVault: vault,
      credentialAuthorizations: { check: () => ({ authorized: true }) },
    });
    const filling = h.service.fillCredential({ profileId: tab.profileId, targetId: tab.targetId, instanceId: 'instance-1', vaultItemRef: 'test-item', fields: [{ selector: '#password', kind: 'password' }] });
    await begun;
    locked = true; finishScan();
    const result = await filling;
    expect(result).toMatchObject({ decision: 'denied', outcome: 'failed', reason: 'vault_locked', data: null });
    expect(sendCommand).not.toHaveBeenCalledWith(expect.objectContaining({ command: 'type' }));
    expect(JSON.stringify({ result, audit: h.audits })).not.toContain(placeholder);
  });
});
