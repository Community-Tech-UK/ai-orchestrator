import { isMainThread, parentPort } from 'node:worker_threads';
import { getElectronParentPort } from '../../runtime/electron-parent-port';
import { GitStatusWatcher } from './git-status-watcher';
import type {
  GitStatusWatcherWorkerInboundMsg,
  GitStatusWatcherWorkerOutboundMsg,
} from './git-status-watcher-protocol';

interface WorkerTransport {
  postMessage(message: GitStatusWatcherWorkerOutboundMsg): void;
  onMessage(listener: (message: GitStatusWatcherWorkerInboundMsg) => void): void;
}

function createTransport(): WorkerTransport {
  if (parentPort) {
    const port = parentPort;
    return {
      postMessage: message => port.postMessage(message),
      onMessage: listener => port.on('message', listener),
    };
  }

  const electronPort = getElectronParentPort();
  if (electronPort) {
    electronPort.start?.();
    return {
      postMessage: message => electronPort.postMessage(message),
      onMessage: listener => {
        electronPort.on('message', event =>
          listener(event.data as GitStatusWatcherWorkerInboundMsg),
        );
      },
    };
  }

  if (isMainThread && typeof process.send === 'function') {
    process.once('disconnect', () => process.exit(0));
    return {
      postMessage: message => process.send?.(message),
      onMessage: listener => {
        process.on('message', message =>
          listener(message as GitStatusWatcherWorkerInboundMsg),
        );
      },
    };
  }

  throw new Error(
    'git-status-watcher-worker-main must run in a worker thread, utility process, or child process',
  );
}

const transport = createTransport();
const watcher = new GitStatusWatcher();

watcher.on('status-changed', event => {
  transport.postMessage({ type: 'status-changed', event });
});

transport.onMessage(message => {
  void handleMessage(message);
});

async function handleMessage(message: GitStatusWatcherWorkerInboundMsg): Promise<void> {
  try {
    if (message.type === 'set-repos') {
      await watcher.setRepos(message.repoPaths);
      transport.postMessage({
        type: 'response',
        id: message.id,
        ok: true,
        watchedRepos: watcher.watchedRepos(),
      });
      return;
    }

    await watcher.stop();
    transport.postMessage({
      type: 'response',
      id: message.id,
      ok: true,
      watchedRepos: watcher.watchedRepos(),
    });
  } catch (error) {
    transport.postMessage({
      type: 'response',
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
