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
});
