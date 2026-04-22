import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => ({
  isPackaged: false,
  getAppPath: vi.fn(() => '/Users/suas/work/orchestrat0r/ai-orchestrator'),
}));

vi.mock('electron', () => ({
  app: electronMock,
}));

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  buildDeferPermissionHookCommand,
  ensureHookScript,
  getDeferPermissionHookPath,
} from '../hook-path-resolver';

describe('hook-path-resolver', () => {
  let tempRoot = '';

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'hook-path-resolver-'));
    electronMock.isPackaged = false;
    electronMock.getAppPath.mockReturnValue(tempRoot);
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    delete (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  });

  it('resolves the packaged hook path from process resources', () => {
    electronMock.isPackaged = true;
    Object.defineProperty(process, 'resourcesPath', {
      value: '/mock/resources',
      configurable: true,
    });

    expect(getDeferPermissionHookPath()).toBe(
      path.join('/mock/resources', 'hooks', 'defer-permission-hook.mjs')
    );
  });

  it('returns the development hook path when not packaged', () => {
    expect(getDeferPermissionHookPath()).toBe(
      path.join(tempRoot, 'src', 'main', 'cli', 'hooks', 'defer-permission-hook.mjs')
    );
  });

  it('ensures the hook is executable when needed', () => {
    const hookPath = path.join(tempRoot, 'src', 'main', 'cli', 'hooks', 'defer-permission-hook.mjs');
    mkdirSync(path.dirname(hookPath), { recursive: true });
    writeFileSync(hookPath, '#!/usr/bin/env node\n', 'utf-8');
    chmodSync(hookPath, 0o644);

    const resolved = ensureHookScript();

    expect(resolved).toBe(hookPath);
    expect(statSync(hookPath).mode & 0o777).toBe(0o755);
  });

  it('throws when the hook file is missing', () => {
    expect(() => ensureHookScript()).toThrow(/Defer permission hook script not found/);
  });

  it('formats the defer hook as a node command on Unix', () => {
    expect(
      buildDeferPermissionHookCommand('/tmp/my hooks/defer-permission-hook.mjs', 'darwin'),
    ).toBe(`node '/tmp/my hooks/defer-permission-hook.mjs'`);
  });

  it('formats the defer hook as a node command on Windows', () => {
    expect(
      buildDeferPermissionHookCommand('C:\\Program Files\\AI Orchestrator\\defer-permission-hook.mjs', 'win32'),
    ).toBe('node "C:\\Program Files\\AI Orchestrator\\defer-permission-hook.mjs"');
  });
});
