import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared/types/settings.types';
import { hydrateRemoteNodeConfig, resetRemoteNodeConfig } from '../remote-node/remote-node-config';

const local = vi.hoisted(() => ({ name: 'ct-test-mac', readPairing: vi.fn() }));
vi.mock('node:os', () => ({ homedir: () => '/home/operator', hostname: () => 'Test-Mac.local' }));
vi.mock('../remote-node/worker-mode-runtime-service', () => ({
  readWorkerModePairing: local.readPairing,
}));
import { getLocalBrowserComputer } from './browser-local-computer';

describe('the operator-enabled local browser computer', () => {
  beforeEach(() => {
    resetRemoteNodeConfig();
    local.readPairing.mockReset().mockReturnValue({ config: { name: 'ct-test-mac' } });
  });

  it('is absent by default and reads no worker files before the operator opts in', () => {
    expect(getLocalBrowserComputer()).toBeUndefined();
    expect(local.readPairing).not.toHaveBeenCalled();
  });

  it('uses the same name as the existing worker after settings are hydrated', () => {
    hydrateRemoteNodeConfig({ ...DEFAULT_SETTINGS, browserLocalComputerEnabled: true });
    expect(getLocalBrowserComputer()).toMatchObject({
      id: 'local', name: 'ct-test-mac', capabilities: { hasBrowserMcp: true },
    });
    expect(local.readPairing).toHaveBeenCalledWith('/home/operator/.orchestrator/worker-node.json');
  });

  it('uses its hostname on a computer without a worker pairing', () => {
    local.readPairing.mockReturnValue({ config: null });
    hydrateRemoteNodeConfig({ ...DEFAULT_SETTINGS, browserLocalComputerEnabled: true });
    expect(getLocalBrowserComputer()?.name).toBe('Test-Mac');
  });
});
