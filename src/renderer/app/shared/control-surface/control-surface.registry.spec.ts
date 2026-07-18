import { describe, expect, it } from 'vitest';

import {
  CONTROL_SURFACES,
  listControlNavGroups,
  listDashboardNavGroups,
  listSettingsExternalLinks,
} from './control-surface.registry';
import type {
  ControlSurfaceGroup,
  ControlSurfaceKind,
  ControlSurfaceLayout,
} from './control-surface.types';

const EXPECTED_PATHS = [
  '/settings',
  '/chat-search',
  '/automations',
  '/campaigns',
  '/workflows',
  '/hooks',
  '/skills',
  '/reviews',
  '/doc-review',
  '/specialists',
  '/worktrees',
  '/supervision',
  '/rlm',
  '/training',
  '/memory',
  '/memory/stats',
  '/debate',
  '/verification',
  '/verification/settings',
  '/lsp',
  '/mcp',
  '/browser',
  '/files',
  '/vcs',
  '/tasks',
  '/plan',
  '/stats',
  '/cost',
  '/snapshots',
  '/replay',
  '/remote-access',
  '/search',
  '/security',
  '/logs',
  '/observations',
  '/knowledge',
  '/plugins',
  '/models',
  '/remote-config',
  '/communication',
  '/multi-edit',
  '/editor',
  '/archive',
  '/semantic-search',
  '/channels',
  '/remote-nodes',
  '/ask-council',
  '/work',
  '/compare/split',
] as const;

const VALID_GROUPS: readonly ControlSurfaceGroup[] = [
  'settings',
  'automation',
  'agents',
  'knowledge',
  'code',
  'monitoring',
  'integrations',
  'storage',
];

const VALID_KINDS: readonly ControlSurfaceKind[] = [
  'setting',
  'tool',
  'view',
  'diagnostic',
  'integration',
  'workflow',
];

const VALID_LAYOUTS: readonly ControlSurfaceLayout[] = ['standard', 'wide', 'fullBleed'];

describe('control surface registry', () => {
  it('has unique ids and paths', () => {
    const surfaces = CONTROL_SURFACES;

    expect(new Set(surfaces.map((surface) => surface.id)).size).toBe(surfaces.length);
    expect(new Set(surfaces.map((surface) => surface.path)).size).toBe(surfaces.length);
  });

  it('contains every in-scope route path', () => {
    const paths = CONTROL_SURFACES.map((surface) => surface.path).sort();

    expect(paths).toEqual([...EXPECTED_PATHS].sort());
  });

  it('registers the Workboard as a full-bleed automation view visible in navigation', () => {
    const workboard = CONTROL_SURFACES.find((surface) => surface.id === 'workboard');
    expect(workboard).toBeDefined();
    expect(workboard?.path).toBe('/work');
    expect(workboard?.group).toBe('automation');
    expect(workboard?.kind).toBe('view');
    expect(workboard?.layout).toBe('fullBleed');
    expect(workboard?.showInDashboardNav).toBe(true);
    expect(workboard?.showInControlNav).toBe(true);
  });

  it('no longer registers the retired Fleet surface', () => {
    expect(CONTROL_SURFACES.some((surface) => surface.id === ('fleet' as string))).toBe(false);
    expect(CONTROL_SURFACES.some((surface) => surface.path === '/fleet')).toBe(false);
  });

  it('has valid metadata for every surface', () => {
    for (const surface of CONTROL_SURFACES) {
      expect(surface.path.startsWith('/')).toBe(true);
      expect(surface.label.trim()).not.toBe('');
      expect(surface.title.trim()).not.toBe('');
      expect(surface.icon.trim()).not.toBe('');
      expect(VALID_GROUPS).toContain(surface.group);
      expect(VALID_KINDS).toContain(surface.kind);
      expect(VALID_LAYOUTS).toContain(surface.layout);
    }
  });

  it('keeps dashboard and settings links inside the Control Center nav', () => {
    const controlIds = new Set(
      listControlNavGroups().flatMap((group) => group.items.map((item) => item.id)),
    );
    const dashboardIds = listDashboardNavGroups().flatMap((group) =>
      group.items.map((item) => item.id),
    );
    const settingsExternalIds = listSettingsExternalLinks().map((item) => item.id);

    for (const id of [...dashboardIds, ...settingsExternalIds]) {
      expect(controlIds.has(id)).toBe(true);
    }
  });
});
