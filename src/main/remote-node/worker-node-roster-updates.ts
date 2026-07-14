import { IPC_CHANNELS } from '../../shared/types/ipc.types';
import { getLocalModelInventoryService } from '../local-models/local-model-inventory-service';
import { getLogger } from '../logging/logger';
import { getRemoteNodeRosterService } from './remote-node-roster-service';
import type { WorkerNodeRegistry } from './worker-node-registry';

const logger = getLogger('WorkerNodeRosterUpdates');

export function bindWorkerNodeRosterUpdates(registry: WorkerNodeRegistry): () => void {
  const broadcast = () => broadcastNodesToRenderer();
  const refreshLocalModels = () => refreshLocalModelInventory();

  registry.on('node:connected', broadcast);
  registry.on('node:connected', refreshLocalModels);
  registry.on('node:disconnected', broadcast);
  registry.on('node:disconnected', refreshLocalModels);
  registry.on('node:updated', broadcast);
  registry.on('node:local-models-changed', refreshLocalModels);

  return () => {
    registry.removeListener('node:connected', broadcast);
    registry.removeListener('node:connected', refreshLocalModels);
    registry.removeListener('node:disconnected', broadcast);
    registry.removeListener('node:disconnected', refreshLocalModels);
    registry.removeListener('node:updated', broadcast);
    registry.removeListener('node:local-models-changed', refreshLocalModels);
  };
}

function broadcastNodesToRenderer(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BrowserWindow } = require('electron');
    const nodes = getRemoteNodeRosterService().list();
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC_CHANNELS.REMOTE_NODE_NODES_CHANGED, nodes);
    }
  } catch {
    // Not in Electron context (e.g., tests).
  }
}

function refreshLocalModelInventory(): void {
  void getLocalModelInventoryService().refresh().catch((error) => {
    logger.warn('Local model inventory refresh failed after worker roster update', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
