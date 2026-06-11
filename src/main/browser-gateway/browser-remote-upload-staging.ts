import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { getFileTransferService } from '../remote-node/file-transfer-service';
import { getWorkerNodeRegistry } from '../remote-node/worker-node-registry';
import { getLogger } from '../logging/logger';

const logger = getLogger('BrowserRemoteUploadStaging');

export type StageBrowserUploadOnNode = (
  nodeId: string,
  localPath: string,
) => Promise<string>;

/**
 * Stage a coordinator-local file onto a remote worker node so the node's
 * Chrome extension can point `DOM.setFileInputFiles` at a path that exists on
 * THAT machine.
 *
 * Without staging, a remote-node existing-tab upload ships the coordinator's
 * local path string to the other machine; Chrome there backs the `<input>`
 * File with a nonexistent path, the page uploads zero/unreadable bytes, and
 * the site fails server-side ("error uploading") — which looks like file
 * corruption but is simply the wrong filesystem.
 *
 * The staged copy lives under the node's first working directory (the only
 * roots its filesystem RPC is allowed to write inside), in `_scratch/`, the
 * convention for disposable artifacts that code indexing ignores.
 */
export async function stageBrowserUploadOnNode(
  nodeId: string,
  localPath: string,
): Promise<string> {
  const node = getWorkerNodeRegistry().getNode(nodeId);
  const stagingRoot = node?.capabilities.workingDirectories[0];
  if (!stagingRoot) {
    throw new Error(
      'upload_file_remote_staging_unavailable: the remote node has no working directory to stage the upload file into',
    );
  }
  // The remote node may run a different OS than the coordinator — join with
  // the path flavor of the NODE's root, not the local platform's.
  const joiner = isWindowsStylePath(stagingRoot) ? path.win32 : path.posix;
  const remotePath = joiner.join(
    stagingRoot,
    '_scratch',
    'aio-browser-uploads',
    `${randomUUID()}-${sanitizeBasename(localPath)}`,
  );
  const result = await getFileTransferService().copyToRemote({
    localPath,
    remotePath,
    nodeId,
  });
  logger.info('Staged browser upload file on remote node', {
    nodeId,
    localPath,
    remotePath,
    size: result.size,
  });
  return remotePath;
}

function isWindowsStylePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.includes('\\');
}

function sanitizeBasename(localPath: string): string {
  const cleaned = path.basename(localPath).replace(/[^A-Za-z0-9._-]+/g, '_');
  return cleaned || 'upload.bin';
}
