import { describe, expect, it } from 'vitest';

import { NAV_ITEMS, SETTINGS_EXTERNAL_LINKS, resolveSettingsLayout } from './settings-navigation';

describe('settings navigation', () => {
  it('groups Connections with network and remote controls', () => {
    const connections = NAV_ITEMS.find((item) => item.id === 'connections');
    const networkIndex = NAV_ITEMS.findIndex((item) => item.id === 'network');
    const connectionsIndex = NAV_ITEMS.findIndex((item) => item.id === 'connections');
    const remoteNodesIndex = NAV_ITEMS.findIndex((item) => item.id === 'remote-nodes');

    expect(connections?.group).toBe('Network & Remote');
    expect(networkIndex).toBeLessThan(connectionsIndex);
    expect(connectionsIndex).toBeLessThan(remoteNodesIndex);
  });

  it('exposes local-first voice settings with the network and remote controls', () => {
    const voice = NAV_ITEMS.find((item) => item.id === 'voice');
    const connectionsIndex = NAV_ITEMS.findIndex((item) => item.id === 'connections');
    const voiceIndex = NAV_ITEMS.findIndex((item) => item.id === 'voice');
    const remoteNodesIndex = NAV_ITEMS.findIndex((item) => item.id === 'remote-nodes');

    expect(voice).toEqual(expect.objectContaining({
      label: 'Voice',
      group: 'Network & Remote',
      keywords: expect.stringContaining('stt'),
    }));
    expect(connectionsIndex).toBeLessThan(voiceIndex);
    expect(voiceIndex).toBeLessThan(remoteNodesIndex);
  });

  it('does not give Models a static Recommended nav pill', () => {
    const models = NAV_ITEMS.find((item) => item.id === 'models');

    expect(models?.recommended).not.toBe(true);
  });

  it('derives tool-like settings links from the Control Surface registry', () => {
    expect(SETTINGS_EXTERNAL_LINKS.map((item) => item.id).sort()).toEqual([
      'archive',
      'hooks',
      'mcp',
      'models',
      'remote-config',
      'snapshots',
      'worktrees',
    ].sort());
  });

  it('defaults ordinary tabs to the standard layout measure', () => {
    const general = NAV_ITEMS.find((item) => item.id === 'general');
    const display = NAV_ITEMS.find((item) => item.id === 'display');

    expect(resolveSettingsLayout(general)).toBe('standard');
    expect(resolveSettingsLayout(display)).toBe('standard');
    expect(general?.layout).toBeUndefined();
  });

  it('marks Remote Nodes, Permissions, and Auxiliary Models as expanded', () => {
    for (const id of ['remote-nodes', 'permissions', 'auxiliary-models'] as const) {
      const item = NAV_ITEMS.find((entry) => entry.id === id);
      expect(resolveSettingsLayout(item)).toBe('expanded');
      expect(item?.layout).toBe('expanded');
    }
  });

  it('marks Ecosystem and feature pages as embedded', () => {
    for (const id of [
      'ecosystem',
      'models',
      'mcp',
      'hooks',
      'worktrees',
      'snapshots',
      'archive',
      'remote-config',
      'doctor',
    ] as const) {
      const item = NAV_ITEMS.find((entry) => entry.id === id);
      expect(resolveSettingsLayout(item)).toBe('embedded');
      expect(item?.layout).toBe('embedded');
    }
  });
});
