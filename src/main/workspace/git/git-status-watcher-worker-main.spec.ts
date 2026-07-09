import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  GitStatusWatcherWorkerInboundMsg,
  GitStatusWatcherWorkerOutboundMsg,
} from './git-status-watcher-protocol';

type ElectronParentPort = EventEmitter & {
  start: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
};

function processWithParentPort(): NodeJS.Process & { parentPort?: ElectronParentPort } {
  return process as NodeJS.Process & { parentPort?: ElectronParentPort };
}

/** Wait until parentPort.postMessage has been called `count` times. */
async function waitForPostMessages(
  parentPort: ElectronParentPort,
  count: number,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (parentPort.postMessage.mock.calls.length < count) {
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${count} postMessage call(s); got ${parentPort.postMessage.mock.calls.length}`,
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

describe('git-status-watcher-worker-main', () => {
  const originalParentPort = processWithParentPort().parentPort;

  afterEach(() => {
    processWithParentPort().parentPort = originalParentPort;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  function installParentPort(): ElectronParentPort {
    const parentPort = Object.assign(new EventEmitter(), {
      start: vi.fn(),
      postMessage: vi.fn(),
    }) as ElectronParentPort;
    processWithParentPort().parentPort = parentPort;
    return parentPort;
  }

  it('receives set-repos and shutdown over Electron utilityProcess parentPort', async () => {
    const parentPort = installParentPort();
    await import('./git-status-watcher-worker-main');

    const setReposMessage: GitStatusWatcherWorkerInboundMsg = {
      type: 'set-repos',
      id: 1,
      repoPaths: [],
    };
    parentPort.emit('message', { data: setReposMessage });
    await waitForPostMessages(parentPort, 1);

    expect(parentPort.start).toHaveBeenCalledOnce();
    expect(parentPort.postMessage).toHaveBeenCalledWith({
      type: 'response',
      id: 1,
      ok: true,
      watchedRepos: [],
    } satisfies GitStatusWatcherWorkerOutboundMsg);

    const shutdownMessage: GitStatusWatcherWorkerInboundMsg = {
      type: 'shutdown',
      id: 2,
    };
    parentPort.emit('message', { data: shutdownMessage });
    await waitForPostMessages(parentPort, 2);

    expect(parentPort.postMessage).toHaveBeenCalledWith({
      type: 'response',
      id: 2,
      ok: true,
      watchedRepos: [],
    } satisfies GitStatusWatcherWorkerOutboundMsg);
  });
});
