import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
});
