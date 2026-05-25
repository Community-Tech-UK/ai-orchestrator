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
    expect(background).toContain('chrome.tabs.onUpdated');
    expect(background).toContain('chrome.tabs.onRemoved');
    expect(background).toContain("type: 'tab_inventory'");
    expect(background).toContain("type: 'poll_command'");
    expect(background).toContain("type: 'command_result'");
    expect(background).toContain('executeBrowserCommand');
    expect(manifest.permissions).toContain('alarms');
    expect(manifest.host_permissions).toEqual(['http://*/*', 'https://*/*']);
  });
});
