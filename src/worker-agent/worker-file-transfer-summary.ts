import * as fs from 'fs';
import * as path from 'path';
import type {
  WorkerNodeBrowserAutomationSummary,
  WorkerNodeFileTransferRoot,
  WorkerNodeFileTransferSummary,
} from '../shared/types/worker-node.types';
import type { WorkerFileTransferConfig } from './worker-config';

const BROWSER_DOWNLOADS_TRANSFER_ROOT_ID = 'browserDownloads';

/**
 * The file-transfer summary a worker advertises: configured roots plus, when
 * browser automation is enabled, a read-only root for the managed browser's
 * Downloads folder (which always wins over a configured root reusing its id).
 */
export function buildWorkerFileTransferSummary(
  config: WorkerFileTransferConfig | undefined,
  browserSummary: WorkerNodeBrowserAutomationSummary,
): WorkerNodeFileTransferSummary | undefined {
  if (!config) {
    return undefined;
  }
  const roots = config.enabled ? rootsForSummary(config.roots ?? [], browserSummary) : [];
  return {
    enabled: config.enabled,
    maxFileBytes: config.maxFileBytes ?? 50 * 1024 * 1024,
    roots,
  };
}

function rootsForSummary(
  configuredRoots: WorkerNodeFileTransferRoot[],
  browserSummary: WorkerNodeBrowserAutomationSummary,
): WorkerNodeFileTransferRoot[] {
  const browserDownloads = browserDownloadsTransferRoot(browserSummary);
  if (!browserDownloads) {
    return [...configuredRoots];
  }
  const roots = configuredRoots.filter(
    (root) => root.id.toLowerCase() !== BROWSER_DOWNLOADS_TRANSFER_ROOT_ID.toLowerCase(),
  );
  return [browserDownloads, ...roots];
}

function browserDownloadsTransferRoot(
  browserSummary: WorkerNodeBrowserAutomationSummary,
): WorkerNodeFileTransferRoot | null {
  if (!browserSummary.enabled) {
    return null;
  }
  const downloadsPath = path.join(browserSummary.profileDir, 'Downloads');
  try {
    fs.mkdirSync(downloadsPath, { recursive: true });
  } catch (error) {
    console.warn('[WorkerAgent] Could not prepare browser downloads transfer root', {
      downloadsPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  return {
    id: BROWSER_DOWNLOADS_TRANSFER_ROOT_ID,
    label: 'Browser Downloads',
    path: downloadsPath,
    read: true,
    write: false,
  };
}
