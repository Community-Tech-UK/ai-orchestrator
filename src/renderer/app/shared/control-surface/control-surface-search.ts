import { searchSettings, settingsSearchCatalog, type SettingsSearchEntry } from '../../../../shared/types/settings-search-catalog';
import { NAV_ITEMS } from '../../features/settings/settings-navigation';
import { getControlSurface } from './control-surface.registry';
import type { ControlSurfaceNavGroup } from './control-surface.types';

export interface ControlNavSearchResult {
  readonly id: string;
  readonly label: string;
  /** The Settings section a single setting lives in, shown under its name. */
  readonly section: string | null;
  readonly icon: string;
  readonly path: string;
  readonly queryParams: { readonly setting: string } | null;
  readonly fragment: string | undefined;
  readonly score: number;
}

export interface ControlNavSearchGroup {
  readonly id: 'pages' | 'settings';
  readonly label: string;
  readonly results: readonly ControlNavSearchResult[];
}

/** Enough to find the right row without pushing the page matches out of a short window. */
const MAX_SETTINGS_RESULTS = 12;

const SECTION_CATALOG: readonly SettingsSearchEntry[] = NAV_ITEMS.map(item => ({
  key: item.id,
  label: item.label,
  description: `${item.summary} ${item.keywords ?? ''}`,
  tab: item.id,
}));
const SETTING_CATALOG = settingsSearchCatalog();

/**
 * Pages, Settings sections and single settings that match a query, best first. A blank query returns null, which
 * means "not searching". A Settings section sharing a page's name is left out: it would be the same place twice.
 */
export function searchControlNav(query: string, navGroups: readonly ControlSurfaceNavGroup[]): readonly ControlNavSearchGroup[] | null {
  if (!query.trim()) return null;
  const surfaces = new Map(navGroups.flatMap(group => group.items.map(item => [item.id as string, { item, group }] as const)));
  const pageCatalog = [...surfaces.values()].map(({ item, group }) => ({
    key: item.id, label: item.label, description: `${group.label} ${item.subtitle ?? ''}`, tab: '',
  }));
  const pages = searchSettings(query, pageCatalog).flatMap(match => {
    const surface = surfaces.get(match.key);
    return surface ? [{
      id: match.key, label: surface.item.label, section: null, icon: surface.item.icon,
      path: surface.item.path, queryParams: null, fragment: undefined, score: match.score,
    }] : [];
  });

  const pageLabels = new Set(pageCatalog.map(page => page.label.toLowerCase()));
  const settingsIcon = getControlSurface('settings').icon;
  const sections = searchSettings(query, SECTION_CATALOG)
    .filter(match => !pageLabels.has(match.label.toLowerCase()))
    .map(match => ({
      id: `section:${match.key}`, label: match.label, section: 'Settings', icon: settingsIcon,
      path: '/settings', queryParams: null, fragment: match.tab, score: match.score,
    }));
  const settings = searchSettings(query, SETTING_CATALOG).map(match => ({
    id: `setting:${match.key}`, label: match.label,
    section: `Settings: ${NAV_ITEMS.find(item => item.id === match.tab)?.label ?? match.tab}`,
    icon: settingsIcon, path: '/settings', queryParams: { setting: match.key }, fragment: undefined, score: match.score,
  }));

  const groups: ControlNavSearchGroup[] = [];
  if (pages.length) groups.push({ id: 'pages', label: 'Pages', results: pages });
  if (sections.length || settings.length) {
    const ranked = [...sections, ...settings].sort((a, b) => b.score - a.score);
    groups.push({ id: 'settings', label: 'Settings', results: ranked.slice(0, MAX_SETTINGS_RESULTS) });
  }
  // The very first result is the one Enter opens, so the group holding the best match goes first. Pages win a tie.
  return groups.sort((a, b) => b.results[0].score - a.results[0].score);
}
