import { createHash } from 'node:crypto';
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
  expectedSha256?: string;
  overwrite?: boolean;
}

export interface CopyFromRemoteParams {
  remotePath: string;
  localPath: string;
  nodeId: string;
  expectedSha256?: string;
  overwrite?: boolean;
}

export interface FileTransferResult {
  ok: true;
  size: number;
  from: string;
  to: string;
  sha256: string;
  mimeType?: string;
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
    const digest = sha256(buffer);
    if (params.expectedSha256 && digest !== params.expectedSha256.toLowerCase()) {
      throw new Error('integrity_mismatch');
    }
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
    const readback = await server.sendRpc<FsReadFileResult>(
      nodeId,
      COORDINATOR_TO_NODE.FS_READ_FILE,
      { path: remotePath }
    );
    const remoteBuffer = Buffer.from(readback.data, 'base64');
    if (
      readback.size !== buffer.length ||
      remoteBuffer.length !== buffer.length ||
      sha256(remoteBuffer) !== digest
    ) {
      throw new Error('copy_to_remote_integrity_mismatch');
    }

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
      to: `${node.name ?? nodeId}:${remotePath}`,
      sha256: digest,
      mimeType: readback.mimeType,
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
    if (params.overwrite !== true) {
      try {
        await fs.stat(resolvedLocal);
        throw new Error(`destination_exists: ${resolvedLocal}`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('destination_exists:')) {
          throw error;
        }
        if (!isNotFoundError(error)) {
          throw error;
        }
      }
    }
    await fs.mkdir(path.dirname(resolvedLocal), { recursive: true });
    const buffer = Buffer.from(result.data, 'base64');
    await fs.writeFile(resolvedLocal, buffer);
    const localBuffer = await fs.readFile(resolvedLocal);
    const digest = sha256(localBuffer);
    if (
      result.size !== buffer.length ||
      localBuffer.length !== buffer.length ||
      digest !== sha256(buffer)
    ) {
      await fs.rm(resolvedLocal, { force: true });
      throw new Error('copy_from_remote_integrity_mismatch');
    }
    if (params.expectedSha256 && digest !== params.expectedSha256.toLowerCase()) {
      await fs.rm(resolvedLocal, { force: true });
      throw new Error('integrity_mismatch');
    }

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
      to: resolvedLocal,
      sha256: digest,
      mimeType: result.mimeType,
    };
  }
}

export function getFileTransferService(): FileTransferService {
  return FileTransferService.getInstance();
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
