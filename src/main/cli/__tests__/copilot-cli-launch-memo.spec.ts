/**
 * The default-argument memo on `resolveCopilotCliLaunch`.
 *
 * Discovery runs up to three synchronous child processes, one bounded at
 * 5000ms, and `createCopilotAdapter()` calls it once per spawn on the Electron
 * main thread. Without the memo every Copilot session start can stall the UI.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resolveCommandOnPathMock = vi.hoisted(() => vi.fn());
const spawnSyncMock = vi.hoisted(() => vi.fn(() => ({ status: 0 })));

vi.mock('../cli-path-resolver', () => ({ resolveCommandOnPath: resolveCommandOnPathMock }));
// Spread the real module: other modules in this graph import execFile/spawn
// from it, and a partial mock breaks their import binding, not just this one.
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  spawnSync: spawnSyncMock,
}));

import {
  resolveCopilotCliLaunch,
  resetCopilotCliLaunchCache,
} from '../copilot-cli-launch';

describe('resolveCopilotCliLaunch memoization', () => {
  beforeEach(() => {
    resetCopilotCliLaunchCache();
    resolveCommandOnPathMock.mockReset();
    spawnSyncMock.mockClear();
  });

  afterEach(() => {
    resetCopilotCliLaunchCache();
  });

  it('probes once for repeated default lookups', () => {
    resolveCommandOnPathMock.mockReturnValue('/usr/local/bin/copilot');

    const first = resolveCopilotCliLaunch();
    const second = resolveCopilotCliLaunch();
    const third = resolveCopilotCliLaunch();

    expect(first).toEqual(second);
    expect(second).toEqual(third);
    expect(resolveCommandOnPathMock).toHaveBeenCalledTimes(1);
  });

  it('caches a negative result too — that is the expensive path', () => {
    // Nothing found: `which copilot`, `which gh`, and on a machine with gh the
    // 5s `gh copilot --help` probe. Repeating that per spawn was the bug.
    resolveCommandOnPathMock.mockReturnValue(null);

    expect(resolveCopilotCliLaunch()).toBeNull();
    expect(resolveCopilotCliLaunch()).toBeNull();

    expect(resolveCommandOnPathMock).toHaveBeenCalledTimes(2); // copilot, then gh
  });

  it('re-probes after the cache is reset, so an install is picked up', () => {
    resolveCommandOnPathMock.mockReturnValue(null);
    expect(resolveCopilotCliLaunch()).toBeNull();

    resolveCommandOnPathMock.mockReturnValue('/usr/local/bin/copilot');
    // Without the reset the stale null would outlive the install.
    expect(resolveCopilotCliLaunch()).toBeNull();

    resetCopilotCliLaunchCache();
    expect(resolveCopilotCliLaunch()).toMatchObject({ command: '/usr/local/bin/copilot' });
  });

  it('never serves the memo to a caller passing explicit env or platform', () => {
    resolveCommandOnPathMock.mockReturnValue('/usr/local/bin/copilot');
    resolveCopilotCliLaunch();
    resolveCommandOnPathMock.mockClear();

    resolveCopilotCliLaunch({ PATH: '/custom' }, 'linux');

    expect(resolveCommandOnPathMock).toHaveBeenCalledWith('copilot', { PATH: '/custom' }, 'linux');
  });
});
