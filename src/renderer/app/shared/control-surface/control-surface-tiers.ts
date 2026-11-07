import type { ControlSurfaceId, ControlSurfaceNavGroup } from './control-surface.types';

export const EVERYDAY_SURFACE_IDS: ReadonlySet<ControlSurfaceId> = new Set<ControlSurfaceId>([
  'settings', 'chat-search', 'workboard', 'automations', 'plan-queue', 'campaigns',
  'doc-review', 'reviews', 'verification', 'memory', 'memory-review', 'vcs',
  'worktrees', 'search', 'browser', 'remote-nodes', 'channels', 'mcp', 'cost', 'local-ai',
]);
export const NEVER_MORE_SURFACE_IDS: readonly ControlSurfaceId[] = [
  'workboard', 'doc-review', 'plan-queue', 'memory-review', 'automations', 'settings',
];

export function splitNavGroupsByTier(groups: readonly ControlSurfaceNavGroup[]) {
  const select = (tier: 'everyday' | 'more') => groups
    .map(group => ({ ...group, items: group.items.filter(item => item.tier === tier) }))
    .filter(group => group.items.length > 0);
  const everyday = select('everyday');
  const more = select('more');
  return { everyday, more, moreCount: more.reduce((count, group) => count + group.items.length, 0) };
}

export function readNavPreference(key: string): boolean {
  try { return localStorage.getItem(key) === 'true'; } catch { return false; }
}
export function writeNavPreference(key: string, value: boolean): void {
  try { localStorage.setItem(key, String(value)); } catch { /* Storage is optional. */ }
}
