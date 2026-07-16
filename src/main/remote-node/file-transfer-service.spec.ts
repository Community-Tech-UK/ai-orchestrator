import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { COORDINATOR_TO_NODE } from './worker-node-rpc';
import { FileTransferService } from './file-transfer-service';

const getNode = vi.fn();
const sendRpc = vi.fn();

vi.mock('./worker-node-registry', () => ({
  getWorkerNodeRegistry: () => ({ getNode }),
}));

vi.mock('./worker-node-connection', () => ({
  getWorkerNodeConnectionServer: () => ({ sendRpc }),
}));

describe('FileTransferService', () => {
  beforeEach(() => {
    FileTransferService._resetForTesting();
    getNode.mockReset();
    sendRpc.mockReset();
    getNode.mockReturnValue({ id: 'node-1', name: 'builder' });
  });

  it('verifies copied remote bytes by reading them back', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'aio-transfer-'));
    const localPath = join(tempDir, 'app.aab');
    const data = Buffer.from('fake bundle bytes');
    writeFileSync(localPath, data);
    sendRpc
      .mockResolvedValueOnce({ ok: true, size: data.length })
      .mockResolvedValueOnce({
        data: data.toString('base64'),
        size: data.length,
        mimeType: 'application/octet-stream',
      });

    const result = await new FileTransferService().copyToRemote({
      localPath,
      remotePath: '/work/_scratch/app.aab',
      nodeId: 'node-1',
    });

    expect(result).toMatchObject({
      ok: true,
      size: data.length,
      to: 'builder:/work/_scratch/app.aab',
    });
    expect(sendRpc).toHaveBeenNthCalledWith(1, 'node-1', COORDINATOR_TO_NODE.FS_WRITE_FILE, {
      path: '/work/_scratch/app.aab',
      data: data.toString('base64'),
      mkdirp: true,
    });
    expect(sendRpc).toHaveBeenNthCalledWith(2, 'node-1', COORDINATOR_TO_NODE.FS_READ_FILE, {
      path: '/work/_scratch/app.aab',
    });
  });

  it('rejects a remote copy when the read-back hash does not match', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'aio-transfer-'));
    const localPath = join(tempDir, 'app.aab');
    writeFileSync(localPath, 'fake bundle bytes');
    sendRpc
      .mockResolvedValueOnce({ ok: true, size: 17 })
      .mockResolvedValueOnce({
        data: Buffer.from('different bytes').toString('base64'),
        size: 15,
        mimeType: 'application/octet-stream',
      });

    await expect(new FileTransferService().copyToRemote({
      localPath,
      remotePath: '/work/_scratch/app.aab',
      nodeId: 'node-1',
    })).rejects.toThrow('copy_to_remote_integrity_mismatch');
  });

  it('returns SHA-256 and MIME metadata for copied remote files', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'aio-transfer-'));
    const localPath = join(tempDir, 'downloaded.pdf');
    const data = Buffer.from('remote pdf bytes');
    sendRpc.mockResolvedValueOnce({
      exists: true,
      isDirectory: false,
      size: data.length,
      modifiedAt: 1,
      platform: 'win32',
      withinBrowsableRoot: true,
    });
    sendRpc.mockResolvedValueOnce({
      data: data.toString('base64'),
      size: data.length,
      mimeType: 'application/pdf',
    });

    const result = await new FileTransferService().copyFromRemote({
      remotePath: 'C:\\Users\\James\\Downloads\\downloaded.pdf',
      localPath,
      nodeId: 'node-1',
    });

    expect(result).toMatchObject({
      ok: true,
      size: data.length,
      from: 'builder:C:\\Users\\James\\Downloads\\downloaded.pdf',
      to: localPath,
      sha256: createHash('sha256').update(data).digest('hex'),
      mimeType: 'application/pdf',
    });
    expect(readFileSync(localPath)).toEqual(data);
  });

  it('streams a large push in chunks and trusts the worker commit hash instead of a read-back', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'aio-transfer-stream-'));
    const localPath = join(tempDir, 'big.bin');
    const data = Buffer.from('0123456789'); // 10 bytes → chunks of 4/4/2
    writeFileSync(localPath, data);
    const digest = createHash('sha256').update(data).digest('hex');
    sendRpc.mockImplementation(async (_nodeId: string, method: string, params: { done?: boolean }) => {
      if (method !== COORDINATOR_TO_NODE.FS_WRITE_FILE_CHUNK) {
        throw new Error(`unexpected RPC ${method}`);
      }
      return params.done
        ? { ok: true, bytesWritten: 2, committed: true, size: data.length, sha256: digest }
        : { ok: true, bytesWritten: 4, committed: false };
    });

    const service = new FileTransferService({ streamThresholdBytes: 8, streamChunkBytes: 4 });
    const result = await service.copyToRemote({
      localPath,
      remotePath: '/work/_scratch/big.bin',
      nodeId: 'node-1',
    });

    expect(result).toMatchObject({ ok: true, size: data.length, sha256: digest });
    const chunkCalls = sendRpc.mock.calls.filter(
      (call) => call[1] === COORDINATOR_TO_NODE.FS_WRITE_FILE_CHUNK,
    );
    expect(chunkCalls.map((call) => (call[2] as { offset: number; done: boolean }).offset)).toEqual([0, 4, 8]);
    expect((chunkCalls[2][2] as { done: boolean }).done).toBe(true);
  });

  it('rejects a streamed push when the worker commit hash differs', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'aio-transfer-stream-'));
    const localPath = join(tempDir, 'big.bin');
    writeFileSync(localPath, '0123456789');
    sendRpc.mockImplementation(async (_nodeId: string, _method: string, params: { done?: boolean }) =>
      params.done
        ? { ok: true, bytesWritten: 2, committed: true, size: 10, sha256: 'f'.repeat(64) }
        : { ok: true, bytesWritten: 4, committed: false });

    const service = new FileTransferService({ streamThresholdBytes: 8, streamChunkBytes: 4 });
    await expect(service.copyToRemote({
      localPath,
      remotePath: '/work/_scratch/big.bin',
      nodeId: 'node-1',
    })).rejects.toThrow('copy_to_remote_integrity_mismatch');
  });

  it('streams a large pull in chunks into a partial file and renames it into place', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'aio-transfer-stream-'));
    const localPath = join(tempDir, 'pulled.bin');
    const data = Buffer.from('abcdefghij'); // 10 bytes → chunks of 4/4/2
    sendRpc.mockImplementation(async (_nodeId: string, method: string, params: { offset?: number; length?: number }) => {
      if (method === COORDINATOR_TO_NODE.FS_STAT) {
        return { exists: true, isDirectory: false, size: data.length, modifiedAt: 1, platform: 'win32', withinBrowsableRoot: true };
      }
      if (method === COORDINATOR_TO_NODE.FS_READ_FILE_CHUNK) {
        const offset = params.offset ?? 0;
        const slice = data.subarray(offset, offset + (params.length ?? 4));
        return {
          data: slice.toString('base64'),
          bytesRead: slice.length,
          size: data.length,
          eof: offset + slice.length >= data.length,
        };
      }
      throw new Error(`unexpected RPC ${method}`);
    });

    const service = new FileTransferService({ streamThresholdBytes: 8, streamChunkBytes: 4 });
    const result = await service.copyFromRemote({
      remotePath: 'C:\\Users\\James\\Downloads\\pulled.bin',
      localPath,
      nodeId: 'node-1',
    });

    expect(result).toMatchObject({
      ok: true,
      size: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
    });
    expect(readFileSync(localPath)).toEqual(data);
  });
});
