import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const createAdapter = vi.hoisted(() => vi.fn());
vi.mock('../main/cli/adapters/adapter-factory', () => ({ createCliAdapter: createAdapter }));
import { LocalInstanceManager } from './local-instance-manager';

describe('worker additional folder boundary', () => {
  let root: string;
  let manager: LocalInstanceManager;
  beforeEach(() => {
    vi.clearAllMocks(); root = mkdtempSync(join(tmpdir(), 'oc-folders-'));
    mkdirSync(join(root, 'allowed')); mkdirSync(join(root, 'outside'));
    manager = new LocalInstanceManager([join(root, 'allowed')]);
    createAdapter.mockImplementation(() => Object.assign(new EventEmitter(), { spawn: vi.fn().mockResolvedValue(1), terminate: vi.fn().mockResolvedValue(undefined), getName: () => 'fixture' }));
  });
  afterEach(async () => { await manager.terminateAll(); rmSync(root, { recursive: true, force: true }); });
  it('rejects a folder symlink escaping the registered worker roots before spawning', async () => {
    symlinkSync(join(root, 'outside'), join(root, 'allowed', 'link'), 'dir');
    await expect(manager.spawn({ instanceId: 'fixture', cliType: 'opencode', workingDirectory: join(root, 'allowed'), additionalDirectories: [join(root, 'allowed', 'link')] }))
      .rejects.toThrow(/Additional working directory/);
    expect(createAdapter).not.toHaveBeenCalled();
  });
  it('passes an existing registered folder to the worker adapter', async () => {
    mkdirSync(join(root, 'allowed', 'extra'));
    await manager.spawn({ instanceId: 'fixture', cliType: 'opencode', workingDirectory: join(root, 'allowed'), additionalDirectories: [join(root, 'allowed', 'extra')] });
    expect(createAdapter).toHaveBeenCalledWith('opencode', expect.objectContaining({ additionalDirectories: [join(root, 'allowed', 'extra')] }));
  });
});
