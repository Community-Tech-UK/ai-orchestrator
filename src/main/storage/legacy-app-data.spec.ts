import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listLegacyAppData, trashLegacyAppData } from './legacy-app-data';
import { waitForChangeClockTick } from '../testing/change-clock.test-helpers';

let root: string;

afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

async function makeAppData(): Promise<{ appData: string; currentUserData: string }> {
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'legacy-app-data-')));
  const appData = join(root, 'Application Support');
  await fs.mkdir(appData);
  const currentUserData = join(appData, 'harness');
  await fs.mkdir(currentUserData);
  return { appData, currentUserData };
}

describe('listLegacyAppData', () => {
  it('lists the old folder with its size and file count', async () => {
    const { appData, currentUserData } = await makeAppData();
    const legacy = join(appData, 'claude-orchestrator');
    await fs.mkdir(join(legacy, 'rlm'), { recursive: true });
    await fs.writeFile(join(legacy, 'settings.json'), Buffer.alloc(100));
    await fs.writeFile(join(legacy, 'rlm', 'rlm.db'), Buffer.alloc(250));

    const info = await listLegacyAppData(appData, currentUserData);

    expect(info).not.toBeNull();
    expect(info!.name).toBe('claude-orchestrator');
    expect(info!.path).toBe(legacy);
    expect(info!.bytes).toBe(350);
    expect(info!.files).toBe(2);
    expect(info!.newestModified).toBeGreaterThan(0);
  });

  it('ignores a link, a similarly named folder, and the folder when it is the live user data', async () => {
    const { appData, currentUserData } = await makeAppData();
    const realElsewhere = join(root, 'elsewhere');
    await fs.mkdir(realElsewhere);
    await fs.writeFile(join(realElsewhere, 'big.bin'), Buffer.alloc(500));
    await fs.symlink(realElsewhere, join(appData, 'claude-orchestrator'));
    await fs.mkdir(join(appData, 'claude-orchestrator2'));
    await fs.writeFile(join(appData, 'claude-orchestrator2', 'x'), Buffer.alloc(10));

    // The linked candidate is ignored and the similarly named folder does not match.
    expect(await listLegacyAppData(appData, currentUserData)).toBeNull();

    // A legacy-named folder that IS the live user data folder is never listed.
    await fs.rm(join(appData, 'claude-orchestrator'));
    const liveLegacy = join(appData, 'claude-orchestrator');
    await fs.mkdir(liveLegacy);
    await fs.writeFile(join(liveLegacy, 'settings.json'), Buffer.alloc(10));
    expect(await listLegacyAppData(appData, liveLegacy)).toBeNull();
    // The same folder is listed once it is not the live one.
    expect((await listLegacyAppData(appData, currentUserData))?.name).toBe('claude-orchestrator');
  });

  it.each(['error', 'cap', 'during-scan'] as const)('refuses an uncertain legacy scan (%s) before issuing a descriptor', async kind => {
    const { appData, currentUserData } = await makeAppData();
    const legacy = join(appData, 'claude-orchestrator');
    await fs.mkdir(legacy);
    await fs.writeFile(join(legacy, 'settings'), 'aaaa');
    const read = fs.readdir.bind(fs);
    const entries = await fs.readdir(legacy, { withFileTypes: true, encoding: 'buffer' });
    const spy = vi.spyOn(fs, 'readdir');
    if (kind === 'error') spy.mockRejectedValueOnce(new Error('synthetic unreadable directory'));
    else if (kind === 'cap') spy.mockResolvedValueOnce(Array.from({ length: 50_001 }, () => entries[0]));
    else spy.mockImplementationOnce(async (...args) => {
      const listed = await read(...args);
      waitForChangeClockTick();
      await fs.writeFile(join(legacy, 'unreviewed'), 'bbbb');
      return listed;
    });
    await expect(listLegacyAppData(appData, currentUserData)).rejects.toThrow(/Review again/);
    expect(await fs.readFile(join(legacy, 'settings'), 'utf8')).toBe('aaaa');
  });

  it('binds symlink metadata without following its retained target', async () => {
    const { appData, currentUserData } = await makeAppData();
    const legacy = join(appData, 'claude-orchestrator');
    await fs.mkdir(legacy);
    const retained = join(root, 'retained');
    await fs.writeFile(retained, Buffer.alloc(1024));
    await fs.symlink(retained, join(legacy, 'linked'));
    const info = (await listLegacyAppData(appData, currentUserData))!;
    expect(info.bytes).toBe(0);
    const bin = vi.fn(async () => undefined);
    await fs.unlink(join(legacy, 'linked'));
    await fs.symlink(currentUserData, join(legacy, 'linked'));
    await expect(trashLegacyAppData(info, bin)).rejects.toThrow(/Review again/);
    expect(bin).not.toHaveBeenCalled();
    expect((await fs.lstat(retained)).size).toBe(1024);
  });

  it('lists nothing when the folder is absent', async () => {
    const { appData, currentUserData } = await makeAppData();
    expect(await listLegacyAppData(appData, currentUserData)).toBeNull();
  });
});

describe('trashLegacyAppData', () => {
  it('calls the trash function once and logs the move', async () => {
    const { appData, currentUserData } = await makeAppData();
    const legacy = join(appData, 'claude-orchestrator');
    await fs.mkdir(legacy);
    await fs.writeFile(join(legacy, 'settings.json'), Buffer.alloc(10));
    const info = (await listLegacyAppData(appData, currentUserData))!;
    const trashItem = vi.fn(async () => undefined);

    await trashLegacyAppData(info, trashItem);

    expect(trashItem).toHaveBeenCalledExactlyOnceWith(legacy);
  });

  it('propagates a failed Bin move without removing the folder', async () => {
    const { appData, currentUserData } = await makeAppData();
    const legacy = join(appData, 'claude-orchestrator');
    await fs.mkdir(legacy);
    await fs.writeFile(join(legacy, 'settings.json'), Buffer.alloc(10));
    const info = (await listLegacyAppData(appData, currentUserData))!;
    const trashItem = vi.fn(async () => {
      throw new Error('trash failed');
    });

    await expect(trashLegacyAppData(info, trashItem)).rejects.toThrow('trash failed');
    expect(await fs.readdir(legacy)).toEqual(['settings.json']);
  });
});
