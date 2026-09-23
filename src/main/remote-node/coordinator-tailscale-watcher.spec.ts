import { describe, expect, it, vi } from 'vitest';
import {
  CoordinatorTailscaleWatcher,
  probeCoordinatorTailscale,
  type CoordinatorTailscaleProbeResult,
} from './coordinator-tailscale-watcher';

describe('probeCoordinatorTailscale', () => {
  it('treats a Tailscale interface as running without calling the CLI', async () => {
    const readStatus = vi.fn();
    await expect(probeCoordinatorTailscale({ getTailscaleIp: () => '100.68.10.5', readStatus }))
      .resolves.toEqual({ state: 'running' });
    expect(readStatus).not.toHaveBeenCalled();
  });

  it('separates switched off from not installed', async () => {
    await expect(probeCoordinatorTailscale({
      getTailscaleIp: () => null,
      readStatus: async () => ({ backendState: 'Stopped', dnsName: 'mac.ts.net' }),
    })).resolves.toEqual({ state: 'stopped', backendState: 'Stopped' });
    await expect(probeCoordinatorTailscale({
      getTailscaleIp: () => null,
      readStatus: async () => null,
    })).resolves.toEqual({ state: 'absent' });
  });
});

function makeWatcher(results: CoordinatorTailscaleProbeResult[], paired = [{ id: 'node-1', name: 'windows-pc' }]) {
  const notify = vi.fn();
  const onStateChange = vi.fn();
  const probe = vi.fn(async () => results.shift() ?? { state: 'running' as const });
  const watcher = new CoordinatorTailscaleWatcher({
    probe,
    listPairedNodes: () => paired,
    notify,
    onStateChange,
  });
  return { watcher, notify, onStateChange, probe };
}

describe('CoordinatorTailscaleWatcher', () => {
  it('warns once per transition to stopped, naming nodes last seen over Tailscale', async () => {
    const { watcher, notify, onStateChange } = makeWatcher([
      { state: 'running' },
      { state: 'stopped', backendState: 'Stopped' },
      { state: 'stopped', backendState: 'Stopped' },
      { state: 'running' },
      { state: 'stopped', backendState: 'Stopped' },
    ]);
    watcher.noteNodeConnected({ id: 'node-1', name: 'windows-pc', address: '::ffff:100.113.93.104' });

    for (let i = 0; i < 5; i++) await watcher.checkNow();

    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[0][0]).toEqual({
      title: 'Tailscale is off on this computer',
      body: 'windows-pc connects to Harness over Tailscale and cannot reach it until Tailscale is turned back on (Tailscale reports "Stopped").',
    });
    expect(onStateChange.mock.calls.map((call) => call[0])).toEqual(['running', 'stopped', 'running', 'stopped']);
  });

  it('warns at startup when Tailscale is already off, without route evidence', async () => {
    const { watcher, notify } = makeWatcher([{ state: 'stopped' }]);
    await watcher.checkNow();
    expect(notify.mock.calls[0][0].body).toBe(
      'Worker nodes that connect over Tailscale cannot reach Harness until Tailscale is turned back on.',
    );
    expect(watcher.getDisconnectedNodeHint('node-1')).toMatch(/If this worker connects over Tailscale/);
  });

  it('stays quiet with no paired nodes or when Tailscale is not installed', async () => {
    const noNodes = makeWatcher([{ state: 'stopped' }], []);
    await noNodes.watcher.checkNow();
    expect(noNodes.notify).not.toHaveBeenCalled();

    const absent = makeWatcher([{ state: 'absent' }]);
    await absent.watcher.checkNow();
    expect(absent.notify).not.toHaveBeenCalled();
    expect(absent.watcher.getDisconnectedNodeHint('node-1')).toBeUndefined();
  });

  it('hints only nodes that used Tailscale once any route evidence exists', async () => {
    const { watcher } = makeWatcher([{ state: 'stopped' }], [
      { id: 'node-1', name: 'windows-pc' },
      { id: 'node-2', name: 'lan-box' },
    ]);
    watcher.noteNodeConnected({ id: 'node-1', name: 'windows-pc', address: '100.113.93.104' });
    watcher.noteNodeConnected({ id: 'node-2', name: 'lan-box', address: '192.168.0.40' });
    await watcher.checkNow();

    expect(watcher.getDisconnectedNodeHint('node-1')).toMatch(/This worker connects over Tailscale/);
    expect(watcher.getDisconnectedNodeHint('node-2')).toBeUndefined();
  });

  it('shares one in-flight probe between overlapping checks', async () => {
    const { watcher, probe } = makeWatcher([{ state: 'running' }]);
    await Promise.all([watcher.checkNow(), watcher.checkNow()]);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
