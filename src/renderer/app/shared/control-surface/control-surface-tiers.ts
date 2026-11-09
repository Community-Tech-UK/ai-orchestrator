import type { ControlSurfaceId } from './control-surface.types';

export const EVERYDAY_SURFACE_IDS: ReadonlySet<ControlSurfaceId> = new Set<ControlSurfaceId>([
  'settings', 'chat-search', 'workboard', 'automations', 'plan-queue', 'campaigns',
  'doc-review', 'reviews', 'verification', 'memory', 'memory-review', 'vcs',
  'worktrees', 'search', 'browser', 'remote-nodes', 'channels', 'mcp', 'cost', 'local-ai',
]);
