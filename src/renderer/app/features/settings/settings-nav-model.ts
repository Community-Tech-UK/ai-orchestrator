import { NAV_ITEMS, type NavBadge, type SettingsTab } from './settings-navigation';
import { SETTINGS_PAGES, type SettingsNavPage } from './settings-pages';
import { SETTINGS_SECTION_TARGETS } from './settings-section-targets';
import { searchSettings } from '../../../../shared/types/settings-search-catalog';

export function buildSettingsNav(query: string) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (text: string) => words.every(word => text.toLowerCase().includes(word));
  const rowTabs = new Set(searchSettings(query).map(match => match.tab));
  const pages = SETTINGS_PAGES.map(page => {
    const ownMatch = matches(`${page.label} ${page.summary} ${page.keywords ?? ''}`);
    const matchingTabs = page.tabs.map(id => NAV_ITEMS.find(tab => tab.id === id)!).filter(tab => (ownMatch || rowTabs.has(tab.id) || matches(
      `${tab.id} ${tab.label} ${tab.summary} ${tab.group ?? ''} ${tab.keywords ?? ''} ` +
      SETTINGS_SECTION_TARGETS.filter(target => target.tab === tab.id)
        .map(target => `${target.label} ${target.keywords}`).join(' '),
    )));
    return { page, matchingTabs };
  }).filter(entry => entry.matchingTabs.length > 0);
  return { pages, hasResults: pages.length > 0 };
}
export function pageBadge(page: SettingsNavPage, badges: Partial<Record<SettingsTab, NavBadge>>): NavBadge | null {
  const severity = { error: 4, warn: 3, info: 2, ok: 1 };
  return page.tabs.map(tab => badges[tab]).filter((badge): badge is NavBadge => !!badge)
    .sort((a, b) => severity[b.status] - severity[a.status])[0] ?? null;
}
