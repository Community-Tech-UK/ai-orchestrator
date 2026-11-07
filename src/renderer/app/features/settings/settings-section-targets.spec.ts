import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { settingsSearchCatalog, withSectionTargets, bestSettingMatch } from '../../../../shared/types/settings-search-catalog';
import { NAV_ITEMS } from './settings-navigation';
import { SETTINGS_SECTION_TARGETS } from './settings-section-targets';

const files = {
  host: resolve(__dirname, 'settings.component.html'),
  connections: resolve(__dirname, 'connections-settings-tab.component.ts'),
};
const catalog = withSectionTargets(settingsSearchCatalog(), SETTINGS_SECTION_TARGETS);
describe('typed settings section targets', () => {
  it('covers every tab without metadata rows', () => {
    const covered = new Set(catalog.map(entry => entry.tab));
    expect(NAV_ITEMS.filter(tab => !covered.has(tab.id))).toEqual([]);
  });
  it('anchors every target in its owning template with no duplicate tab/label pairs', () => {
    expect(new Set(SETTINGS_SECTION_TARGETS.map(t => `${t.tab}:${t.label}`)).size).toBe(SETTINGS_SECTION_TARGETS.length);
    for (const target of SETTINGS_SECTION_TARGETS) {
      const source = readFileSync(target.tab === 'connections' ? files.connections : files.host, 'utf8');
      expect(source, `${target.tab}.${target.anchor}`).toContain(`data-setting-key="section:${target.tab}.${target.anchor}"`);
    }
  });
  it.each([
    ['discord', 'connections'], ['whatsapp', 'connections'], ['tailscale', 'mobile'],
    ['quota', 'provider-quota'], ['shortcut', 'keyboard'], ['vpn', 'network'],
  ])('lands %s on %s', (query, tab) => {
    expect(bestSettingMatch(query, catalog)?.tab).toBe(tab);
  });
});
