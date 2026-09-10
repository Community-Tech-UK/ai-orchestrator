import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
// @ts-expect-error jsdom has no local declarations; existing sibling tests use it untyped.
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { PROTECTED_ORIGIN, settle } from './browser-secret-recovery.testutil';

function popupHarness(reviewToken: string | null, protectionEnabled = true) {
  const dom = new JSDOM(readFileSync('resources/browser-extension/popup.html', 'utf8'));
  const sendMessage = vi.fn(async (message: { type: string }) => {
    if (message.type === 'get_secret_protection') {
      return protectionEnabled
        ? { ok: true, protectionEnabled: true, origins: [PROTECTED_ORIGIN], tabCount: 1, reviewToken }
        : { ok: true, protectionEnabled: false, origins: [], tabCount: 0, reviewToken: null };
    }
    return { ok: true, extensionVersion: '0.2.20', gatewayEnabled: !reviewToken, bridges: [], sharedTabs: [] };
  });
  runInNewContext(readFileSync('resources/browser-extension/popup.js', 'utf8'), {
    chrome: { runtime: { getManifest: () => ({}), sendMessage, reload: vi.fn() } },
    document: dom.window.document,
  });
  return { dom, sendMessage, document: dom.window.document as Document };
}

describe('secret recovery popup', () => {
  it('discloses affected sites and requires a fresh off-gateway review', async () => {
    const h = popupHarness(null);
    await settle();
    expect(h.document.getElementById('secret-protection')?.hidden).toBe(false);
    expect(h.document.getElementById('protected-origins')?.textContent).toContain(PROTECTED_ORIGIN);
    expect(h.document.getElementById('secret-recovery-confirm')).toHaveProperty('disabled', true);
    expect(h.document.getElementById('reset-secret-protection')).toHaveProperty('disabled', true);
    expect(h.document.getElementById('secret-protection')?.textContent).toContain('including any secrets still present');
  });

  it('does not let synthetic checkbox and click events reset protection', async () => {
    const h = popupHarness('TEST_ONLY_REVIEW_TOKEN');
    await settle();
    const checkbox = h.document.getElementById('secret-recovery-confirm') as HTMLInputElement;
    const button = h.document.getElementById('reset-secret-protection') as HTMLButtonElement;
    expect(checkbox.disabled).toBe(false);
    expect(button.disabled).toBe(true);
    checkbox.checked = true;
    checkbox.dispatchEvent(new h.dom.window.Event('change'));
    expect(button.disabled).toBe(true);
    button.disabled = false;
    button.dispatchEvent(new h.dom.window.Event('click'));
    await settle();
    expect(h.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'reset_secret_protection' }));
  });

  it('shows that Harness Settings disabled protection instead of listing a locked origin', async () => {
    const h = popupHarness(null, false);
    await settle();
    expect(h.document.getElementById('secret-protection')?.hidden).toBe(false);
    expect(h.document.getElementById('secret-protection-disclosure')?.textContent)
      .toContain('turned off in Harness Settings');
    expect(h.document.getElementById('protected-origins')?.textContent).toBe('');
    expect(h.document.getElementById('secret-recovery-confirm-label')?.hidden).toBe(true);
    expect(h.document.getElementById('reset-secret-protection')?.hidden).toBe(true);
    expect(h.document.getElementById('secret-protection-reset-note')?.hidden).toBe(true);
    expect(h.document.getElementById('secret-protection')?.textContent)
      .not.toContain('Agents cannot read protected tabs');
  });
});
