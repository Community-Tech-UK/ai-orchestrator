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

async function flushMicrotasks(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
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
    await flushMicrotasks();

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
    await flushMicrotasks();

    expect(parentPort.postMessage).toHaveBeenCalledWith({
      type: 'response',
      id: 2,
      ok: true,
      watchedRepos: [],
    } satisfies GitStatusWatcherWorkerOutboundMsg);
  });
});
