import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { COORDINATOR_TO_NODE } from './worker-node-rpc';
import { createRemoteNodeFileTransferImplementations } from './remote-node-file-transfer-mcp-service';

const node = {
  id: 'node-1',
  name: 'windows-pc',
  status: 'connected',
  activeInstances: 0,
  capabilities: {
    workingDirectories: ['C:\\work'],
    fileTransfer: {
      enabled: true,
      maxFileBytes: 16,
      roots: [
        {
          id: 'downloads',
          label: 'Downloads',
          path: 'C:\\Users\\James\\Downloads',
          read: true,
          write: false,
        },
        {
          id: 'scratch',
          label: 'AIO Scratch',
          path: 'C:\\Users\\James\\.orchestrator\\_scratch\\aio-transfers',
          read: true,
          write: true,
        },
      ],
    },
  },
};

const sendRpc = vi.fn();
const copyFromRemote = vi.fn();
const copyToRemote = vi.fn();

vi.mock('./worker-node-registry', () => ({
  getWorkerNodeRegistry: () => ({
    getAllNodes: () => [node],
    getNode: (nodeId: string) => (nodeId === node.id ? node : undefined),
  }),
  resolveWorkerNodeTarget: (selector: string) =>
    selector === node.id || selector === node.name
      ? { nodeId: node.id }
      : { error: `No connected worker node matched "${selector}"` },
}));

vi.mock('./worker-node-connection', () => ({
  getWorkerNodeConnectionServer: () => ({
    isNodeConnected: (nodeId: string) => nodeId === node.id,
    sendRpc,
  }),
}));

vi.mock('./file-transfer-service', () => ({
  getFileTransferService: () => ({
    copyFromRemote,
    copyToRemote,
  }),
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('RemoteNodeFileTransferMcpService', () => {
  beforeEach(() => {
    sendRpc.mockReset();
    copyFromRemote.mockReset();
    copyToRemote.mockReset();
  });

  it('refuses downloads larger than the node fileTransfer max before reading bytes', async () => {
    const tools = createRemoteNodeFileTransferImplementations({
      resolveLocalWorkspace: () => mkdtempSync(join(tmpdir(), 'aio-transfer-workspace-')),
    });
    sendRpc.mockResolvedValueOnce({
      exists: true,
      isDirectory: false,
      size: 17,
      modifiedAt: Date.now(),
      platform: 'win32',
      withinBrowsableRoot: true,
    });

    await expect(tools.downloadFromNode({
      node: 'windows-pc',
      remotePath: 'C:\\Users\\James\\Downloads\\large.pdf',
      localPath: '_scratch/large.pdf',
    }, { callerInstanceId: null })).rejects.toThrow(/file_too_large_for_v1_transfer/);

    expect(sendRpc).toHaveBeenCalledOnce();
    expect(sendRpc).toHaveBeenCalledWith(
      'node-1',
      COORDINATOR_TO_NODE.FS_STAT,
      { path: 'C:\\Users\\James\\Downloads\\large.pdf' },
    );
    expect(copyFromRemote).not.toHaveBeenCalled();
  });

  it('passes overwrite through to the lower-level remote download service', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'aio-transfer-workspace-'));
    const destination = join(workspace, '_scratch', 'file.pdf');
    mkdirSync(join(workspace, '_scratch'), { recursive: true });
    writeFileSync(destination, 'old bytes');
    const tools = createRemoteNodeFileTransferImplementations({
      resolveLocalWorkspace: () => workspace,
    });
    sendRpc.mockResolvedValueOnce({
      exists: true,
      isDirectory: false,
      size: 9,
      modifiedAt: Date.now(),
      platform: 'win32',
      withinBrowsableRoot: true,
    });
    copyFromRemote.mockResolvedValueOnce({
      ok: true,
      size: 9,
      from: 'windows-pc:C:\\Users\\James\\Downloads\\file.pdf',
      to: destination,
      sha256: 'a'.repeat(64),
      mimeType: 'application/pdf',
    });

    await tools.downloadFromNode({
      node: 'windows-pc',
      remotePath: 'C:\\Users\\James\\Downloads\\file.pdf',
      localPath: '_scratch/file.pdf',
      overwrite: true,
    }, { callerInstanceId: null });

    expect(copyFromRemote).toHaveBeenCalledWith({
      nodeId: 'node-1',
      remotePath: 'C:\\Users\\James\\Downloads\\file.pdf',
      localPath: destination,
      expectedSha256: undefined,
      overwrite: true,
    });
  });

  it('refuses a local download destination that is a symlink out of the workspace', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'aio-transfer-workspace-'));
    const outside = mkdtempSync(join(tmpdir(), 'aio-transfer-outside-'));
    const destination = join(workspace, '_scratch', 'file.pdf');
    mkdirSync(join(workspace, '_scratch'), { recursive: true });
    writeFileSync(join(outside, 'file.pdf'), 'outside bytes');
    symlinkSync(join(outside, 'file.pdf'), destination);
    const tools = createRemoteNodeFileTransferImplementations({
      resolveLocalWorkspace: () => workspace,
    });
    sendRpc.mockResolvedValueOnce({
      exists: true,
      isDirectory: false,
      size: 9,
      modifiedAt: Date.now(),
      platform: 'win32',
      withinBrowsableRoot: true,
    });

    await expect(tools.downloadFromNode({
      node: 'windows-pc',
      remotePath: 'C:\\Users\\James\\Downloads\\file.pdf',
      localPath: '_scratch/file.pdf',
      overwrite: true,
    }, { callerInstanceId: null })).rejects.toThrow(/local_write_refused/);

    expect(copyFromRemote).not.toHaveBeenCalled();
  });

  it('refuses a local upload source symlink that resolves outside the workspace', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'aio-transfer-workspace-'));
    const outside = mkdtempSync(join(tmpdir(), 'aio-transfer-outside-'));
    writeFileSync(join(outside, 'secret.pdf'), 'outside bytes');
    symlinkSync(join(outside, 'secret.pdf'), join(workspace, 'link.pdf'));
    const tools = createRemoteNodeFileTransferImplementations({
      resolveLocalWorkspace: () => workspace,
    });

    await expect(tools.uploadToNode({
      node: 'windows-pc',
      localPath: 'link.pdf',
    }, { callerInstanceId: null })).rejects.toThrow(/local_write_refused/);

    expect(copyToRemote).not.toHaveBeenCalled();
  });

  it('does not hash candidates from approval-required roots during search', async () => {
    const downloadsRoot = node.capabilities.fileTransfer.roots[0] as { approvalRequired?: boolean };
    downloadsRoot.approvalRequired = true;
    try {
      const tools = createRemoteNodeFileTransferImplementations();
      sendRpc.mockResolvedValueOnce({
        entries: [
          {
            path: 'C:\\Users\\James\\Downloads\\invoice.pdf',
            name: 'invoice.pdf',
            size: 9,
            modifiedAt: Date.now(),
            isDirectory: false,
            isSymlink: false,
            restricted: false,
            extension: '.pdf',
          },
        ],
        truncated: false,
      });

      const result = await tools.findNodeFiles({
        node: 'windows-pc',
        roots: ['downloads'],
        includeHash: true,
      }, { callerInstanceId: null }) as { candidates: Array<{ sha256?: string; approvalRequired?: boolean }> };

      expect(sendRpc).toHaveBeenCalledOnce();
      expect(result.candidates[0]).toMatchObject({ approvalRequired: true });
      expect(result.candidates[0]?.sha256).toBeUndefined();
    } finally {
      delete downloadsRoot.approvalRequired;
    }
  });

  it('returns node and browser context when a browser download search is ambiguous', async () => {
    const tools = createRemoteNodeFileTransferImplementations();
    const now = Date.now();
    sendRpc.mockResolvedValueOnce({
      entries: [
        {
          path: 'C:\\Users\\James\\Downloads\\invoice-1.pdf',
          name: 'invoice-1.pdf',
          size: 9,
          modifiedAt: now,
          isDirectory: false,
          isSymlink: false,
          restricted: false,
          extension: '.pdf',
        },
        {
          path: 'C:\\Users\\James\\Downloads\\invoice-2.pdf',
          name: 'invoice-2.pdf',
          size: 9,
          modifiedAt: now,
          isDirectory: false,
          isSymlink: false,
          restricted: false,
          extension: '.pdf',
        },
      ],
      truncated: false,
    });

    const result = await tools.collectBrowserDownload({
      node: 'windows-pc',
      fileNameHint: 'invoice',
      extensions: ['.pdf'],
      profileId: 'profile-1',
      browserTargetId: 'target-1',
    }, { callerInstanceId: null });

    expect(result).toMatchObject({
      ok: false,
      code: 'multiple_download_candidates',
      nodeId: 'node-1',
      nodeName: 'windows-pc',
      profileId: 'profile-1',
      browserTargetId: 'target-1',
    });
    expect((result as { candidates: unknown[] }).candidates).toHaveLength(2);
  });

  it('searches the managed browser downloads root before the user Downloads root', async () => {
    const browserDownloadsRoot = {
      id: 'browserDownloads',
      label: 'Browser Downloads',
      path: 'C:\\Users\\James\\.orchestrator\\browser-automation-profile\\Downloads',
      read: true,
      write: false,
    };
    node.capabilities.fileTransfer.roots.push(browserDownloadsRoot);
    try {
      const workspace = mkdtempSync(join(tmpdir(), 'aio-transfer-workspace-'));
      const destination = join(workspace, '_scratch', 'aio-transfers', 'invoice.pdf');
      const tools = createRemoteNodeFileTransferImplementations({
        resolveLocalWorkspace: () => workspace,
      });
      const now = Date.now();
      sendRpc
        .mockResolvedValueOnce({
          entries: [
            {
              path: `${browserDownloadsRoot.path}\\invoice.pdf`,
              name: 'invoice.pdf',
              size: 9,
              modifiedAt: now,
              isDirectory: false,
              isSymlink: false,
              restricted: false,
              extension: '.pdf',
            },
          ],
          truncated: false,
        })
        .mockResolvedValueOnce({
          entries: [],
          truncated: false,
        })
        .mockResolvedValueOnce({
          exists: true,
          isDirectory: false,
          size: 9,
          modifiedAt: now,
          platform: 'win32',
          withinBrowsableRoot: true,
        });
      copyFromRemote.mockResolvedValueOnce({
        ok: true,
        size: 9,
        from: `windows-pc:${browserDownloadsRoot.path}\\invoice.pdf`,
        to: destination,
        sha256: 'c'.repeat(64),
        mimeType: 'application/pdf',
      });

      const result = await tools.collectBrowserDownload({
        node: 'windows-pc',
        fileNameHint: 'invoice',
        extensions: ['.pdf'],
      }, { callerInstanceId: null });

      expect(sendRpc).toHaveBeenNthCalledWith(
        1,
        'node-1',
        COORDINATOR_TO_NODE.FS_READ_DIRECTORY,
        { path: browserDownloadsRoot.path, depth: 3, includeHidden: false, limit: 1000 },
      );
      expect(sendRpc).toHaveBeenNthCalledWith(
        2,
        'node-1',
        COORDINATOR_TO_NODE.FS_READ_DIRECTORY,
        { path: 'C:\\Users\\James\\Downloads', depth: 3, includeHidden: false, limit: 1000 },
      );
      expect(result).toMatchObject({
        ok: true,
        candidate: {
          rootId: 'browserDownloads',
          rootLabel: 'Browser Downloads',
          path: `${browserDownloadsRoot.path}\\invoice.pdf`,
        },
      });
    } finally {
      node.capabilities.fileTransfer.roots.pop();
    }
  });

  it('prefers one managed browser download over a matching user Downloads file', async () => {
    const browserDownloadsRoot = {
      id: 'browserDownloads',
      label: 'Browser Downloads',
      path: 'C:\\Users\\James\\.orchestrator\\browser-automation-profile\\Downloads',
      read: true,
      write: false,
    };
    node.capabilities.fileTransfer.roots.push(browserDownloadsRoot);
    try {
      const workspace = mkdtempSync(join(tmpdir(), 'aio-transfer-workspace-'));
      const destination = join(workspace, '_scratch', 'aio-transfers', 'invoice.pdf');
      const tools = createRemoteNodeFileTransferImplementations({
        resolveLocalWorkspace: () => workspace,
      });
      const now = Date.now();
      sendRpc
        .mockResolvedValueOnce({
          entries: [
            {
              path: `${browserDownloadsRoot.path}\\invoice.pdf`,
              name: 'invoice.pdf',
              size: 9,
              modifiedAt: now - 1_000,
              isDirectory: false,
              isSymlink: false,
              restricted: false,
              extension: '.pdf',
            },
          ],
          truncated: false,
        })
        .mockResolvedValueOnce({
          entries: [
            {
              path: 'C:\\Users\\James\\Downloads\\invoice.pdf',
              name: 'invoice.pdf',
              size: 9,
              modifiedAt: now,
              isDirectory: false,
              isSymlink: false,
              restricted: false,
              extension: '.pdf',
            },
          ],
          truncated: false,
        })
        .mockResolvedValueOnce({
          exists: true,
          isDirectory: false,
          size: 9,
          modifiedAt: now - 1_000,
          platform: 'win32',
          withinBrowsableRoot: true,
        });
      copyFromRemote.mockResolvedValueOnce({
        ok: true,
        size: 9,
        from: `windows-pc:${browserDownloadsRoot.path}\\invoice.pdf`,
        to: destination,
        sha256: 'd'.repeat(64),
        mimeType: 'application/pdf',
      });

      const result = await tools.collectBrowserDownload({
        node: 'windows-pc',
        fileNameHint: 'invoice',
        extensions: ['.pdf'],
      }, { callerInstanceId: null });

      expect(result).toMatchObject({
        ok: true,
        remotePath: `${browserDownloadsRoot.path}\\invoice.pdf`,
        candidate: {
          rootId: 'browserDownloads',
          path: `${browserDownloadsRoot.path}\\invoice.pdf`,
        },
      });
    } finally {
      node.capabilities.fileTransfer.roots.pop();
    }
  });

  it('does not let many user Downloads matches hide a managed browser download', async () => {
    const browserDownloadsRoot = {
      id: 'browserDownloads',
      label: 'Browser Downloads',
      path: 'C:\\Users\\James\\.orchestrator\\browser-automation-profile\\Downloads',
      read: true,
      write: false,
    };
    node.capabilities.fileTransfer.roots.push(browserDownloadsRoot);
    try {
      const workspace = mkdtempSync(join(tmpdir(), 'aio-transfer-workspace-'));
      const destination = join(workspace, '_scratch', 'aio-transfers', 'invoice.pdf');
      const tools = createRemoteNodeFileTransferImplementations({
        resolveLocalWorkspace: () => workspace,
      });
      const now = Date.now();
      sendRpc
        .mockResolvedValueOnce({
          entries: [
            {
              path: `${browserDownloadsRoot.path}\\invoice.pdf`,
              name: 'invoice.pdf',
              size: 9,
              modifiedAt: now - 60_000,
              isDirectory: false,
              isSymlink: false,
              restricted: false,
              extension: '.pdf',
            },
          ],
          truncated: false,
        })
        .mockResolvedValueOnce({
          entries: Array.from({ length: 11 }, (_, index) => ({
            path: `C:\\Users\\James\\Downloads\\invoice-${index}.pdf`,
            name: `invoice-${index}.pdf`,
            size: 9,
            modifiedAt: now - index,
            isDirectory: false,
            isSymlink: false,
            restricted: false,
            extension: '.pdf',
          })),
          truncated: false,
        })
        .mockResolvedValueOnce({
          exists: true,
          isDirectory: false,
          size: 9,
          modifiedAt: now - 60_000,
          platform: 'win32',
          withinBrowsableRoot: true,
        });
      copyFromRemote.mockResolvedValueOnce({
        ok: true,
        size: 9,
        from: `windows-pc:${browserDownloadsRoot.path}\\invoice.pdf`,
        to: destination,
        sha256: 'e'.repeat(64),
        mimeType: 'application/pdf',
      });

      const result = await tools.collectBrowserDownload({
        node: 'windows-pc',
        fileNameHint: 'invoice',
        extensions: ['.pdf'],
      }, { callerInstanceId: null });

      expect(result).toMatchObject({
        ok: true,
        remotePath: `${browserDownloadsRoot.path}\\invoice.pdf`,
        candidate: {
          rootId: 'browserDownloads',
          path: `${browserDownloadsRoot.path}\\invoice.pdf`,
        },
      });
    } finally {
      node.capabilities.fileTransfer.roots.pop();
    }
  });

  it('includes the selected browser download candidate when collection succeeds', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'aio-transfer-workspace-'));
    const destination = join(workspace, '_scratch', 'aio-transfers', 'invoice.pdf');
    const tools = createRemoteNodeFileTransferImplementations({
      resolveLocalWorkspace: () => workspace,
    });
    const now = Date.now();
    sendRpc
      .mockResolvedValueOnce({
        entries: [
          {
            path: 'C:\\Users\\James\\Downloads\\invoice.pdf',
            name: 'invoice.pdf',
            size: 9,
            modifiedAt: now,
            isDirectory: false,
            isSymlink: false,
            restricted: false,
            extension: '.pdf',
          },
        ],
        truncated: false,
      })
      .mockResolvedValueOnce({
        exists: true,
        isDirectory: false,
        size: 9,
        modifiedAt: now,
        platform: 'win32',
        withinBrowsableRoot: true,
      });
    copyFromRemote.mockResolvedValueOnce({
      ok: true,
      size: 9,
      from: 'windows-pc:C:\\Users\\James\\Downloads\\invoice.pdf',
      to: destination,
      sha256: 'b'.repeat(64),
      mimeType: 'application/pdf',
    });

    const result = await tools.collectBrowserDownload({
      node: 'windows-pc',
      fileNameHint: 'invoice',
      extensions: ['.pdf'],
      profileId: 'profile-1',
      browserTargetId: 'target-1',
    }, { callerInstanceId: null });

    expect(result).toMatchObject({
      ok: true,
      localPath: destination,
      profileId: 'profile-1',
      browserTargetId: 'target-1',
      candidate: {
        path: 'C:\\Users\\James\\Downloads\\invoice.pdf',
        rootId: 'downloads',
      },
    });
  });
});
