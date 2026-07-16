import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getWorkerNodeConnectionServer } from './worker-node-connection';
import { getWorkerNodeRegistry } from './worker-node-registry';
import { COORDINATOR_TO_NODE } from './worker-node-rpc';
import { getLogger } from '../logging/logger';
import type {
  FsReadFileChunkResult,
  FsReadFileResult,
  FsStatResult,
  FsWriteFileChunkResult,
} from '../../shared/types/remote-fs.types';

const logger = getLogger('FileTransferService');

/** Files at or under this go as one RPC with a read-back verify (the v1 path). */
const STREAM_THRESHOLD_BYTES = 32 * 1024 * 1024;
/** Chunk size for streamed transfers; base64 expansion keeps this under the WS payload cap. */
const STREAM_CHUNK_BYTES = 8 * 1024 * 1024;
/** Total-size cap for streamed transfers; mirrors the worker-side limit. */
export const MAX_STREAM_TRANSFER_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
/** Streamed-transfer RPCs move up to 16 MB per call; the default 30 s is too tight on slow links. */
const STREAM_RPC_TIMEOUT_MS = 120_000;

interface FileTransferServiceOptions {
  streamThresholdBytes?: number;
  streamChunkBytes?: number;
}

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
  private readonly streamThresholdBytes: number;
  private readonly streamChunkBytes: number;

  constructor(options: FileTransferServiceOptions = {}) {
    this.streamThresholdBytes = options.streamThresholdBytes ?? STREAM_THRESHOLD_BYTES;
    this.streamChunkBytes = options.streamChunkBytes ?? STREAM_CHUNK_BYTES;
  }

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
    if (stat.size > MAX_STREAM_TRANSFER_BYTES) {
      throw new Error(
        `File too large: ${stat.size} bytes exceeds the ${MAX_STREAM_TRANSFER_BYTES} byte streaming limit`
      );
    }
    if (stat.size > this.streamThresholdBytes) {
      return this.streamToRemote(params, node.name ?? nodeId, resolvedLocal, stat.size);
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

    const server = getWorkerNodeConnectionServer();
    const remoteStat = await server.sendRpc<FsStatResult>(
      nodeId,
      COORDINATOR_TO_NODE.FS_STAT,
      { path: remotePath }
    );
    if (remoteStat.exists && remoteStat.size > MAX_STREAM_TRANSFER_BYTES) {
      throw new Error(
        `File too large: ${remoteStat.size} bytes exceeds the ${MAX_STREAM_TRANSFER_BYTES} byte streaming limit`
      );
    }
    if (remoteStat.exists && remoteStat.size > this.streamThresholdBytes) {
      return this.streamFromRemote(params, node.name ?? nodeId, resolvedLocal, remoteStat.size);
    }

    // Read from remote via RPC
    const result = await server.sendRpc<FsReadFileResult>(
      nodeId,
      COORDINATOR_TO_NODE.FS_READ_FILE,
      { path: remotePath }
    );

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

  /**
   * Chunked push for files above the single-RPC threshold. The worker writes
   * into a partial file and commits (verify size, hash, rename) on the final
   * chunk; the returned SHA-256 replaces the whole-file read-back verify.
   */
  private async streamToRemote(
    params: CopyToRemoteParams,
    nodeName: string,
    resolvedLocal: string,
    totalSize: number,
  ): Promise<FileTransferResult> {
    const { remotePath, nodeId } = params;
    logger.info('copyToRemote: streaming file', {
      localPath: resolvedLocal, remotePath, nodeId, size: totalSize,
    });
    const server = getWorkerNodeConnectionServer();
    const hash = createHash('sha256');
    const handle = await fs.open(resolvedLocal, 'r');
    let committed: FsWriteFileChunkResult | null = null;
    try {
      let offset = 0;
      const buffer = Buffer.alloc(this.streamChunkBytes);
      while (offset < totalSize) {
        const { bytesRead } = await handle.read(buffer, 0, this.streamChunkBytes, offset);
        if (bytesRead <= 0) {
          throw new Error(`copy_to_remote_short_read: local file ended at ${offset} of ${totalSize} bytes`);
        }
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        const done = offset + bytesRead >= totalSize;
        const result = await server.sendRpc<FsWriteFileChunkResult>(
          nodeId,
          COORDINATOR_TO_NODE.FS_WRITE_FILE_CHUNK,
          {
            path: remotePath,
            data: chunk.toString('base64'),
            offset,
            totalSize,
            done,
            mkdirp: true,
          },
          STREAM_RPC_TIMEOUT_MS,
        );
        offset += bytesRead;
        if (done) {
          committed = result;
        }
      }
    } finally {
      await handle.close();
    }
    const digest = hash.digest('hex');
    if (params.expectedSha256 && digest !== params.expectedSha256.toLowerCase()) {
      throw new Error('integrity_mismatch');
    }
    if (!committed?.committed || committed.size !== totalSize || committed.sha256 !== digest) {
      throw new Error('copy_to_remote_integrity_mismatch');
    }
    logger.info('copyToRemote: streaming complete', {
      localPath: resolvedLocal, remotePath, nodeId, size: totalSize,
    });
    return {
      ok: true,
      size: totalSize,
      from: resolvedLocal,
      to: `${nodeName}:${remotePath}`,
      sha256: digest,
    };
  }

  /**
   * Chunked pull for files above the single-RPC threshold. Bytes land in a
   * local partial file that is renamed into place only after the hash of what
   * was written matches what was read.
   */
  private async streamFromRemote(
    params: CopyFromRemoteParams,
    nodeName: string,
    resolvedLocal: string,
    totalSize: number,
  ): Promise<FileTransferResult> {
    const { remotePath, nodeId } = params;
    logger.info('copyFromRemote: streaming file', {
      remotePath, localPath: resolvedLocal, nodeId, size: totalSize,
    });
    const server = getWorkerNodeConnectionServer();
    await fs.mkdir(path.dirname(resolvedLocal), { recursive: true });
    const partialPath = `${resolvedLocal}.aio-partial`;
    const hash = createHash('sha256');
    const handle = await fs.open(partialPath, 'w');
    try {
      let offset = 0;
      while (offset < totalSize) {
        const chunk = await server.sendRpc<FsReadFileChunkResult>(
          nodeId,
          COORDINATOR_TO_NODE.FS_READ_FILE_CHUNK,
          { path: remotePath, offset, length: this.streamChunkBytes },
          STREAM_RPC_TIMEOUT_MS,
        );
        const buffer = Buffer.from(chunk.data, 'base64');
        if (buffer.length === 0) {
          throw new Error(`copy_from_remote_short_read: remote file ended at ${offset} of ${totalSize} bytes`);
        }
        await handle.write(buffer, 0, buffer.length, offset);
        hash.update(buffer);
        offset += buffer.length;
        if (chunk.eof && offset < totalSize) {
          throw new Error(`copy_from_remote_short_read: remote file ended at ${offset} of ${totalSize} bytes`);
        }
      }
    } catch (error) {
      await handle.close();
      await fs.rm(partialPath, { force: true });
      throw error;
    }
    await handle.close();
    const digest = hash.digest('hex');
    if (params.expectedSha256 && digest !== params.expectedSha256.toLowerCase()) {
      await fs.rm(partialPath, { force: true });
      throw new Error('integrity_mismatch');
    }
    const partialStat = await fs.stat(partialPath);
    if (partialStat.size !== totalSize) {
      await fs.rm(partialPath, { force: true });
      throw new Error('copy_from_remote_integrity_mismatch');
    }
    await fs.rm(resolvedLocal, { force: true });
    await fs.rename(partialPath, resolvedLocal);
    logger.info('copyFromRemote: streaming complete', {
      remotePath, localPath: resolvedLocal, nodeId, size: totalSize,
    });
    return {
      ok: true,
      size: totalSize,
      from: `${nodeName}:${remotePath}`,
      to: resolvedLocal,
      sha256: digest,
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
