import { getControlSurface } from './control-surface.registry';
import type { ControlSurfaceId, ControlSurfaceItem } from './control-surface.types';

interface HubDefinition {
  readonly id: string;
  readonly label: string;
  /** In tab order. The first page is where the hub's menu entry opens. */
  readonly pages: readonly ControlSurfaceId[];
}

/**
 * Every Control Center page lives in exactly one hub, so the menus list about twelve entries and the pages inside a
 * hub appear as tabs. Hidden pages are listed too, so opening one still highlights the hub it belongs to.
 * `navigation-hubs.spec.ts` fails when a registry page is in no hub or in two.
 */
const HUB_DEFINITIONS: readonly HubDefinition[] = [
  { id: 'settings', label: 'Settings', pages: ['settings'] },
  { id: 'work', label: 'Work', pages: ['workboard', 'plan-queue', 'campaigns', 'tasks'] },
  { id: 'automations', label: 'Automations', pages: ['automations', 'workflows', 'hooks'] },
  { id: 'reviews', label: 'Reviews', pages: ['doc-review', 'reviews', 'verification', 'verification-settings', 'debate', 'ask-council'] },
  { id: 'agents', label: 'Agents & models', pages: ['models', 'skills', 'specialists', 'plugins', 'supervision'] },
  {
    id: 'memory', label: 'Memory & knowledge',
    pages: ['memory-review', 'memory', 'memory-stats', 'knowledge', 'rlm', 'observations', 'training'],
  },
  { id: 'code', label: 'Code', pages: ['vcs', 'worktrees', 'plan', 'files', 'lsp', 'multi-edit', 'editor'] },
  { id: 'search', label: 'Search', pages: ['search', 'semantic-search', 'chat-search'] },
  { id: 'usage', label: 'Usage & health', pages: ['cost', 'stats', 'local-ai', 'logs', 'security', 'replay', 'compare-split'] },
  { id: 'browser', label: 'Browser', pages: ['browser'] },
  {
    id: 'connections', label: 'Connections',
    pages: ['mcp', 'channels', 'remote-nodes', 'remote-access', 'remote-config', 'worker-mode', 'communication'],
  },
  { id: 'storage', label: 'Storage', pages: ['snapshots', 'archive'] },
];

const TOOLTIP_PAGE_COUNT = 4;

export interface NavigationHub {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  /** Where the menu entry opens: the first listed page. */
  readonly path: string;
  /** The listed pages, which become the hub's tabs. */
  readonly pages: readonly ControlSurfaceItem[];
  /** The first few page names, for the menu entry's tooltip. */
  readonly summary: string;
}

/** The hubs with at least one page in the Control Center menu. Observations only count once memory is on. */
export function navigationHubs(observationMemoryEnabled = false): readonly NavigationHub[] {
  return HUB_DEFINITIONS.flatMap((hub) => {
    const pages = hub.pages
      .map((id) => getControlSurface(id))
      .filter((page) => page.showInControlNav && (page.id !== 'observations' || observationMemoryEnabled));
    if (!pages.length) return [];
    const names = pages.slice(0, TOOLTIP_PAGE_COUNT).map((page) => page.label);
    const more = pages.length - names.length;
    return [{
      id: hub.id,
      label: hub.label,
      icon: pages[0].icon,
      path: pages[0].path,
      pages,
      summary: more > 0 ? `${names.join(', ')} and ${more} more` : names.join(', '),
    }];
  });
}

export function hubOfSurface(id: ControlSurfaceId): { readonly id: string; readonly label: string } | undefined {
  return HUB_DEFINITIONS.find((hub) => hub.pages.includes(id));
}
