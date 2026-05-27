import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceHashForPath } from '../symbol-id';

vi.mock('electron', () => ({
  app: {
    getPath: () => path.join(tmpdir(), 'codemem-service-warm-workspace-test'),
  },
}));

vi.mock('../../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => ({
      codememEnabled: true,
      codememIndexingEnabled: true,
      codememLspWorkerEnabled: true,
    }),
  }),
}));

import { CodememService } from '../index';

describe('CodememService.warmWorkspace', () => {
  let userDataPath: string;
  let workspacePath: string;
  let service: CodememService | null = null;

  beforeEach(() => {
    userDataPath = path.join(tmpdir(), 'codemem-service-warm-workspace-test');
    workspacePath = path.join(userDataPath, 'workspace');
    rmSync(userDataPath, { recursive: true, force: true });
    mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
  });

  afterEach(async () => {
    if (service) {
      await service.shutdown();
      service = null;
    }
    rmSync(userDataPath, { recursive: true, force: true });
  });

  it('returns immediately for an already-ready workspace without rewarming index or LSP', async () => {
    service = new CodememService();
    const representativeFile = path.join(workspacePath, 'src/index.ts');
    const indexWarm = vi
      .spyOn(service.indexWorkerGateway, 'warmWorkspace')
      .mockResolvedValue({
        indexed: true,
        absPath: workspacePath,
        primaryLanguage: 'typescript',
      });
    const lspReady = vi
      .spyOn(service.gateway, 'ready')
      .mockResolvedValue({ ready: true, filePath: representativeFile });

    await expect(service.warmWorkspace(workspacePath)).resolves.toEqual({
      ready: true,
      filePath: representativeFile,
    });
    expect(service.getWorkspaceLspState(workspacePath)).toBe('ready');

    indexWarm.mockClear();
    lspReady.mockClear();

    await expect(service.warmWorkspace(workspacePath)).resolves.toEqual({
      ready: true,
      filePath: representativeFile,
    });

    expect(indexWarm).not.toHaveBeenCalled();
    expect(lspReady).not.toHaveBeenCalled();
  });

  it('re-emits code index change events from the index worker gateway', () => {
    service = new CodememService();
    const listener = vi.fn();
    service.on('code-index:changed', listener);

    service.indexWorkerGateway.emit('code-index:changed', {
      workspacePath,
      workspaceHash: 'workspace-hash',
      paths: ['src/index.ts'],
      timestamp: 1000,
    });

    expect(listener).toHaveBeenCalledWith({
      workspacePath,
      workspaceHash: 'workspace-hash',
      paths: ['src/index.ts'],
      timestamp: 1000,
    });
  });

  it('ensures workspaces through the index worker gateway instead of main-process cold indexing', async () => {
    service = new CodememService();
    const normalizedPath = path.resolve(workspacePath);
    const workspaceHash = workspaceHashForPath(normalizedPath);
    const coldIndex = vi
      .spyOn(service.indexManager, 'coldIndex')
      .mockRejectedValue(new Error('main-process cold index should not run'));
    const startWatcher = vi
      .spyOn(service.indexManager, 'start')
      .mockRejectedValue(new Error('main-process watcher should not start'));
    const warmWorkspace = vi
      .spyOn(service.indexWorkerGateway, 'warmWorkspace')
      .mockImplementation(async () => {
        service!.store.upsertWorkspaceRoot({
          workspaceHash,
          absPath: normalizedPath,
          headCommit: null,
          primaryLanguage: 'typescript',
          lastIndexedAt: 123,
          merkleRootHash: null,
          pagerankJson: null,
        });
        return {
          indexed: true,
          absPath: normalizedPath,
          primaryLanguage: 'typescript',
        };
      });

    await expect(service.ensureWorkspace(workspacePath)).resolves.toEqual(expect.objectContaining({
      workspaceHash,
      absPath: normalizedPath,
    }));

    expect(warmWorkspace).toHaveBeenCalledWith(normalizedPath, 15_000);
    expect(coldIndex).not.toHaveBeenCalled();
    expect(startWatcher).not.toHaveBeenCalled();
  });
});
