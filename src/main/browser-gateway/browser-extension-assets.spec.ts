import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('browser extension assets', () => {
  it('keeps existing-tab access selected-tab scoped while supporting refresh commands', () => {
    const background = readFileSync('resources/browser-extension/background.js', 'utf-8');
    const manifest = JSON.parse(
      readFileSync('resources/browser-extension/manifest.json', 'utf-8'),
    ) as { permissions?: string[] };
    const popup = readFileSync('resources/browser-extension/popup.js', 'utf-8');

    expect(popup).toContain("addEventListener('click'");
    expect(background).toContain("type: 'attach_tab'");
    expect(background).toContain('tabs.onUpdated');
    expect(background).toContain('tabs.onRemoved');
    expect(background).toContain("type: 'poll_commands'");
    expect(background).toContain("type: 'complete_command'");
    expect(background).toContain('sharedTargets');
    expect(manifest.permissions).not.toContain('alarms');
  });
});
