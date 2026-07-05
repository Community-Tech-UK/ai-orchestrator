import { describe, expect, it } from 'vitest';

import { NAV_ITEMS } from './settings-navigation';

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
});
