import { describe, expect, it } from 'vitest';
import { NAV_ITEMS } from './settings-navigation';
import { SETTINGS_PAGES, pageForTab } from './settings-pages';
import { buildSettingsNav, pageBadge } from './settings-nav-model';

describe('settings pages', () => {
  it('assigns every legacy tab to exactly one of twelve non-empty unique pages', () => {
    expect(SETTINGS_PAGES).toHaveLength(12);
    expect(new Set(SETTINGS_PAGES.map(p => p.label)).size).toBe(12);
    expect(SETTINGS_PAGES.every(p => p.tabs.length > 0)).toBe(true);
    expect(SETTINGS_PAGES.flatMap(p => p.tabs).sort()).toEqual(NAV_ITEMS.map(t => t.id).sort());
    for (const tab of NAV_ITEMS) expect(pageForTab(tab.id).tabs).toContain(tab.id);
  });
  it('searches member tabs and sections, retaining the exact matching tab', () => {
    expect(buildSettingsNav('').pages).toHaveLength(12);
    const result = buildSettingsNav('discord').pages;
    const phone = result.find(entry => entry.page.label === 'Phone & remote');
    expect(phone?.matchingTabs.map(t => t.id)).toContain('connections');
    expect(buildSettingsNav('zzzznotfound').hasResults).toBe(false);
  });
  it('uses the most severe member badge', () => {
    expect(pageBadge(pageForTab('doctor'), {
      doctor: { text: 'Broken', status: 'error' }, 'cli-health': { text: 'Update', status: 'warn' },
    })).toEqual({ text: 'Broken', status: 'error' });
  });
  it.each(['connector', 'Microsoft 365', 'Outlook', 'email', 'calendar', 'mcp'])('finds the connector setup by %s', query => {
    const page = buildSettingsNav(query).pages.find(entry => entry.page.id === 'tools');
    expect(page?.page.label).toBe('Connectors & tools');
    expect(page?.matchingTabs.map(tab => tab.id)).toContain('mcp');
    expect(NAV_ITEMS.find(tab => tab.id === 'mcp')?.label).toBe('Connectors');
  });
});
