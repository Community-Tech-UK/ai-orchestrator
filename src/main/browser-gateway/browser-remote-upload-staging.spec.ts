import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stageBrowserUploadOnNode } from './browser-remote-upload-staging';

const copyToRemote = vi.fn(async () => ({ ok: true as const, size: 8, from: 'a', to: 'b' }));
const getNode = vi.fn();

vi.mock('../remote-node/file-transfer-service', () => ({
  getFileTransferService: () => ({ copyToRemote }),
}));

vi.mock('../remote-node/worker-node-registry', () => ({
  getWorkerNodeRegistry: () => ({ getNode }),
}));

function nodeWithWorkingDirectories(workingDirectories: string[]) {
  return { capabilities: { workingDirectories } };
}

describe('stageBrowserUploadOnNode', () => {
  beforeEach(() => {
    copyToRemote.mockClear();
    getNode.mockReset();
  });

  it('stages into a Windows-style _scratch path when the node root is a Windows path', async () => {
    getNode.mockReturnValue(nodeWithWorkingDirectories(['C:\\work\\aio']));

    const remotePath = await stageBrowserUploadOnNode('node-1', '/Users/james/build/app release.aab');

    expect(remotePath).toMatch(
      /^C:\\work\\aio\\_scratch\\aio-browser-uploads\\[0-9a-f-]+-app_release\.aab$/,
    );
    expect(copyToRemote).toHaveBeenCalledWith({
      localPath: '/Users/james/build/app release.aab',
      remotePath,
      nodeId: 'node-1',
    });
  });

  it('stages into a POSIX-style _scratch path when the node root is a POSIX path', async () => {
    getNode.mockReturnValue(nodeWithWorkingDirectories(['/home/james/aio']));

    const remotePath = await stageBrowserUploadOnNode('node-1', '/Users/james/build/app.aab');

    expect(remotePath).toMatch(
      /^\/home\/james\/aio\/_scratch\/aio-browser-uploads\/[0-9a-f-]+-app\.aab$/,
    );
  });

  it('fails with a clear error when the node has no working directory', async () => {
    getNode.mockReturnValue(nodeWithWorkingDirectories([]));

    await expect(stageBrowserUploadOnNode('node-1', '/tmp/app.aab')).rejects.toThrow(
      'upload_file_remote_staging_unavailable',
    );
    expect(copyToRemote).not.toHaveBeenCalled();
  });

  it('fails with a clear error when the node is not connected', async () => {
    getNode.mockReturnValue(undefined);

    await expect(stageBrowserUploadOnNode('node-1', '/tmp/app.aab')).rejects.toThrow(
      'upload_file_remote_staging_unavailable',
    );
  });
});
