import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('browser extension assets', () => {
  it('ships a live authenticated-tab bridge with command polling and page access', () => {
    const background = readFileSync('resources/browser-extension/background.js', 'utf-8');
    const manifest = JSON.parse(
      readFileSync('resources/browser-extension/manifest.json', 'utf-8'),
    ) as { permissions?: string[]; host_permissions?: string[] };
    const popup = readFileSync('resources/browser-extension/popup.js', 'utf-8');

    expect(popup).toContain("addEventListener('click'");
    expect(background).toContain("type: 'attach_tab'");
    expect(background).toContain('chrome.runtime.connectNative(HOST_NAME)');
    expect(background).toContain('chrome.runtime.lastError?.message');
    expect(background).toContain('chrome.tabs.onUpdated');
    expect(background).toContain('chrome.tabs.onRemoved');
    expect(background).toContain("type: 'tab_inventory'");
    expect(background).toContain("type: 'poll_command'");
    expect(background).toContain("type: 'command_result'");
    expect(background).toContain('executeBrowserCommand');
    expect(background).toContain('findActiveWebTabForSharing');
    expect(background).toContain('lastFocusedWindow: true');
    expect(background).toContain('chrome.tabs.query({})');
    expect(manifest.permissions).toContain('alarms');
    expect(manifest.permissions).toContain('tabGroups');
    expect(manifest.host_permissions).toEqual(['http://*/*', 'https://*/*']);
  });

  it('marks actively controlled tabs with a blue group and page glow', () => {
    const background = readFileSync('resources/browser-extension/background.js', 'utf-8');

    expect(background).toContain('AI Orchestrator');
    expect(background).toContain('chrome.tabs.group');
    expect(background).toContain('chrome.tabGroups.update');
    expect(background).toContain("color: 'blue'");
    expect(background).toContain('installControlGlowScript');
    expect(background).toContain('removeControlGlowScript');
    expect(background).toContain('aio-browser-control-glow');
  });

  it('shows a dev-only extension reload action in the popup', () => {
    const popupHtml = readFileSync('resources/browser-extension/popup.html', 'utf-8');
    const popup = readFileSync('resources/browser-extension/popup.js', 'utf-8');

    expect(popupHtml).toContain('id="reload"');
    expect(popupHtml).toContain('Reload Extension');
    expect(popup).toContain('isDevExtension');
    expect(popup).toContain('getManifest().update_url');
    expect(popup).toContain('chrome.runtime.reload()');
  });
});
