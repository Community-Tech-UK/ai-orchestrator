import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const createAdapter = vi.hoisted(() => vi.fn());
vi.mock('../main/cli/adapters/adapter-factory', () => ({ createCliAdapter: createAdapter }));
import { LocalInstanceManager } from './local-instance-manager';

function fakeAdapter(): EventEmitter {
  return Object.assign(new EventEmitter(), {
    spawn: vi.fn().mockResolvedValue(1), sendInput: vi.fn().mockResolvedValue(undefined), terminate: vi.fn().mockResolvedValue(undefined),
    interrupt: vi.fn(() => ({ status: 'already-idle' })), getName: () => 'fake', getSessionId: () => 'provider-session',
    getRuntimeCapabilities: () => ({ supportsResume: true, supportsForkSession: false, supportsNativeCompaction: false, supportsPermissionPrompts: false, supportsDeferPermission: false, selfManagedAutoCompaction: false }),
  });
}

let dir: string;
let allowed: string;
let jobFolder: string;
let planning: string;
let reports: string;
let manager: LocalInstanceManager;
const folders = () => ({ jobFolder, planningFolder: planning, reportFolder: reports });

beforeEach(() => {
  vi.clearAllMocks();
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'worker-queue-folders-')));
  allowed = join(dir, 'allowed');
  jobFolder = join(dir, 'root', 'queue-worktrees', 'queue', 'job-x');
  planning = join(dir, 'root', 'queue-docs', 'job-x');
  reports = join(dir, 'root', 'queue-reports', 'job-x');
  for (const folder of [allowed, jobFolder, planning, reports, join(dir, 'elsewhere')]) mkdirSync(folder, { recursive: true });
  manager = new LocalInstanceManager([allowed]);
  createAdapter.mockImplementation(() => fakeAdapter());
});
afterEach(async () => { await manager.terminateAll(); rmSync(dir, { recursive: true, force: true }); });

describe('LocalInstanceManager — folders allowed for one Plan Queue job\'s session', () => {
  it('refuses the folders until they are registered, then allows the job folder and its two extra folders', async () => {
    await expect(manager.spawn({ instanceId: 'q-0', cliType: 'claude', workingDirectory: jobFolder })).rejects.toThrow(/not in allowed working directories/);
    manager.registerQueueJobFolders(folders());
    await manager.spawn({ instanceId: 'q-1', cliType: 'claude', workingDirectory: jobFolder, additionalDirectories: [planning, reports] });
    expect(createAdapter).toHaveBeenCalledTimes(1);
    expect(manager.getInstanceCount()).toBe(1);
  });

  it('allows them for that job\'s session only: any other session in the same places is still refused', async () => {
    manager.registerQueueJobFolders(folders());
    await expect(manager.spawn({ instanceId: 'q-2', cliType: 'claude', workingDirectory: planning })).rejects.toThrow(/not in allowed working directories/);
    await expect(manager.spawn({ instanceId: 'q-3', cliType: 'claude', workingDirectory: reports })).rejects.toThrow(/not in allowed working directories/);
    await expect(manager.spawn({ instanceId: 'q-4', cliType: 'claude', workingDirectory: allowed, additionalDirectories: [planning] }))
      .rejects.toThrow(/Additional working directory/);
    await expect(manager.spawn({ instanceId: 'q-5', cliType: 'claude', workingDirectory: jobFolder, additionalDirectories: [join(dir, 'elsewhere')] }))
      .rejects.toThrow(/Additional working directory/);
    expect(createAdapter).not.toHaveBeenCalled();
  });

  it('leaves the worker\'s normal list as it was', async () => {
    manager.registerQueueJobFolders(folders());
    await manager.spawn({ instanceId: 'q-6', cliType: 'claude', workingDirectory: allowed });
    await expect(manager.spawn({ instanceId: 'q-7', cliType: 'claude', workingDirectory: join(dir, 'elsewhere') })).rejects.toThrow(/not in allowed/);
  });

  it('forgets the folders when they are unregistered', async () => {
    manager.registerQueueJobFolders(folders());
    manager.unregisterQueueJobFolders(jobFolder);
    await expect(manager.spawn({ instanceId: 'q-8', cliType: 'claude', workingDirectory: jobFolder })).rejects.toThrow(/not in allowed/);
  });

  it('knows which folders a session is in, while it starts and while it runs, and not after it ends', async () => {
    manager.registerQueueJobFolders(folders());
    expect(manager.hasInstanceInFolders([jobFolder, planning, reports])).toBe(false);
    let release: () => void = () => undefined;
    const slow = fakeAdapter() as EventEmitter & { spawn: ReturnType<typeof vi.fn> };
    slow.spawn.mockImplementation(() => new Promise<number>(resolve => { release = () => resolve(1); }));
    createAdapter.mockImplementationOnce(() => slow);
    const starting = manager.spawn({ instanceId: 'q-9', cliType: 'claude', workingDirectory: jobFolder, additionalDirectories: [reports] });
    await vi.waitFor(() => expect(slow.spawn).toHaveBeenCalled());
    expect(manager.hasInstanceInFolders([jobFolder])).toBe(true); // still starting
    release();
    await starting;
    expect(manager.hasInstanceInFolders([jobFolder])).toBe(true);
    expect(manager.hasInstanceInFolders([reports])).toBe(true); // an extra folder counts
    expect(manager.hasInstanceInFolders([planning])).toBe(false);
    expect(manager.hasInstanceInFolders([join(jobFolder, 'src')])).toBe(false); // the session is not inside a subfolder
    await manager.terminate('q-9');
    expect(manager.hasInstanceInFolders([jobFolder, planning, reports])).toBe(false);
  });
});
