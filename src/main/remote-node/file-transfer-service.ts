import fs from 'node:fs/promises';
import path from 'node:path';
import { getWorkerNodeConnectionServer } from './worker-node-connection';
import { getWorkerNodeRegistry } from './worker-node-registry';
import { COORDINATOR_TO_NODE } from './worker-node-rpc';
import { getLogger } from '../logging/logger';
import type { FsReadFileResult } from '../../shared/types/remote-fs.types';

const logger = getLogger('FileTransferService');

const MAX_LOCAL_READ_SIZE = 50 * 1024 * 1024; // 50 MB

export interface CopyToRemoteParams {
  localPath: string;
  remotePath: string;
  nodeId: string;
}

export interface CopyFromRemoteParams {
  remotePath: string;
  localPath: string;
  nodeId: string;
}

export interface FileTransferResult {
  ok: true;
  size: number;
  from: string;
  to: string;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: FileTransferService | null = null;

export class FileTransferService {
  static getInstance(): FileTransferService {
    if (!instance) {
      instance = new FileTransferService();
    }
    return instance;
  }

  static _resetForTesting(): void {
    instance = null;
  }

  /**
   * Copy a file from the local (coordinator) machine to a remote worker node.
   */
  async copyToRemote(params: CopyToRemoteParams): Promise<FileTransferResult> {
    const { localPath, remotePath, nodeId } = params;

    // Validate node exists and is connected
    const node = getWorkerNodeRegistry().getNode(nodeId);
    if (!node) {
      throw new Error(`Node not found: ${nodeId}`);
    }

    // Read local file
    const resolvedLocal = path.resolve(localPath);
    const stat = await fs.stat(resolvedLocal);
    if (stat.isDirectory()) {
      throw new Error(
        `Cannot copy directory — '${resolvedLocal}' is a directory. Use copyDirectoryToRemote for directories.`
      );
    }
    if (stat.size > MAX_LOCAL_READ_SIZE) {
      throw new Error(
        `File too large: ${stat.size} bytes exceeds ${MAX_LOCAL_READ_SIZE} byte limit`
      );
    }

    const buffer = await fs.readFile(resolvedLocal);
    const data = buffer.toString('base64');

    logger.info('copyToRemote: sending file', {
      localPath: resolvedLocal,
      remotePath,
      nodeId,
      size: buffer.length
    });

    // Write to remote via RPC
    const server = getWorkerNodeConnectionServer();
    await server.sendRpc(nodeId, COORDINATOR_TO_NODE.FS_WRITE_FILE, {
      path: remotePath,
      data,
      mkdirp: true
    });

    logger.info('copyToRemote: complete', {
      localPath: resolvedLocal,
      remotePath,
      nodeId,
      size: buffer.length
    });

    return {
      ok: true,
      size: buffer.length,
      from: resolvedLocal,
      to: `${node.name ?? nodeId}:${remotePath}`
    };
  }

  /**
   * Copy a file from a remote worker node to the local (coordinator) machine.
   */
  async copyFromRemote(
    params: CopyFromRemoteParams
  ): Promise<FileTransferResult> {
    const { remotePath, localPath, nodeId } = params;

    // Validate node exists and is connected
    const node = getWorkerNodeRegistry().getNode(nodeId);
    if (!node) {
      throw new Error(`Node not found: ${nodeId}`);
    }

    logger.info('copyFromRemote: requesting file', {
      remotePath,
      localPath,
      nodeId
    });

    // Read from remote via RPC
    const server = getWorkerNodeConnectionServer();
    const result = await server.sendRpc<FsReadFileResult>(
      nodeId,
      COORDINATOR_TO_NODE.FS_READ_FILE,
      { path: remotePath }
    );

    // Write locally
    const resolvedLocal = path.resolve(localPath);
    await fs.mkdir(path.dirname(resolvedLocal), { recursive: true });
    const buffer = Buffer.from(result.data, 'base64');
    await fs.writeFile(resolvedLocal, buffer);

    logger.info('copyFromRemote: complete', {
      remotePath,
      localPath: resolvedLocal,
      nodeId,
      size: buffer.length
    });

    return {
      ok: true,
      size: buffer.length,
      from: `${node.name ?? nodeId}:${remotePath}`,
      to: resolvedLocal
    };
  }
}

export function getFileTransferService(): FileTransferService {
  return FileTransferService.getInstance();
}
