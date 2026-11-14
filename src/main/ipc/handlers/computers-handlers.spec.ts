/** The Computers page's Plan Queue calls: reading, changing the two switches, and checking a project on a computer. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { IPC_CHANNELS } from '@contracts/channels';
import { ipcMain } from 'electron';
import type { QueueJobProjectCheck } from '../../../shared/types/plan-queue-computers.types';
import type { QueueJobProject, QueueJobsPageView } from '../../../shared/types/plan-queue-computers-page.types';
import type { RemoteNodeRosterEntry } from '../../../shared/types/worker-node.types';
import { QueueJobComputers } from '../../computers/queue-job-computers';
import type { QueueProjectChecker } from '../../computers/queue-job-projects';
import { registerComputersHandlers } from './computers-handlers';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

type Reply = { success: boolean; data?: QueueJobsPageView; error?: { code: string; message: string } };
type IpcHandler = (event: unknown, payload?: unknown) => Promise<Reply>;

function handler(channel: string): IpcHandler {
  const calls = (ipcMain.handle as unknown as { mock: { calls: [string, IpcHandler][] } }).mock.calls;
  const found = calls.filter(([registered]) => registered === channel).at(-1);
  if (!found) throw new Error(`No handler for ${channel}`);
  return found[1];
}

const PROJECT: QueueJobProject = { key: 'repo-aaaaaaaa', name: 'repo', repoRoot: '/work/repo' };
const PASSED: QueueJobProjectCheck = { ok: true, checkedAt: 5, problem: null, summary: 'Checks took 43 s.' };

let dir: string;
let computers: QueueJobComputers;
let checkProject: Mock<QueueProjectChecker>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'computers-handlers-'));
  computers = new QueueJobComputers({
    file: join(dir, 'computers.json'),
    roster: () => [{ id: 'pc', name: 'pc' } as RemoteNodeRosterEntry],
    choices: () => [],
    testMachines: () => [],
  });
  checkProject = vi.fn<QueueProjectChecker>().mockResolvedValue(PASSED);
  vi.mocked(ipcMain.handle).mockClear();
  registerComputersHandlers({ computers: () => computers, projects: () => [PROJECT], checkProject });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the Computers page Plan Queue calls', () => {
  it('reads every computer and the projects the queue knows', async () => {
    const reply = await handler(IPC_CHANNELS.COMPUTERS_GET_QUEUE_JOBS)({});
    expect(reply).toEqual({ success: true, data: { computers: computers.list(), projects: [PROJECT] } });
    expect(reply.data!.computers[0]).toMatchObject({ nodeId: 'pc', takesJobs: false, jobsAtOnce: 2 });
  });

  it('changes the switch and jobs at once together and returns the computers as they now are', async () => {
    const reply = await handler(IPC_CHANNELS.COMPUTERS_CHANGE_QUEUE_JOBS)({}, { nodeId: 'pc', change: { takesJobs: true, jobsAtOnce: 4 } });
    expect(reply.data!.computers[0]).toMatchObject({ takesJobs: true, jobsAtOnce: 4 });
    expect(computers.list()[0]).toMatchObject({ takesJobs: true, jobsAtOnce: 4 });
  });

  it('refuses a change outside 1 to 8, an unknown field and an unpaired computer, changing nothing', async () => {
    const change = handler(IPC_CHANNELS.COMPUTERS_CHANGE_QUEUE_JOBS);
    for (const payload of [
      { nodeId: 'pc', change: { jobsAtOnce: 9 } },
      { nodeId: 'pc', change: { jobsAtOnce: 0 } },
      { nodeId: 'pc', change: { paused: true } },
      { nodeId: 'stranger', change: { takesJobs: true } },
      { nodeId: 'pc' },
    ]) {
      const reply = await change({}, payload);
      expect(reply.success, JSON.stringify(payload)).toBe(false);
      expect(reply.error?.code).toBe('COMPUTERS_CHANGE_QUEUE_JOBS_FAILED');
    }
    expect(computers.list()[0]).toMatchObject({ takesJobs: false, jobsAtOnce: 2 });
  });

  it('checks a project the queue knows and keeps the result under its key', async () => {
    const reply = await handler(IPC_CHANNELS.COMPUTERS_CHECK_QUEUE_PROJECT)({}, { nodeId: 'pc', repoRoot: '/work/repo' });
    expect(checkProject).toHaveBeenCalledWith('pc', '/work/repo');
    expect(reply.data!.computers[0]!.projects).toEqual({ [PROJECT.key]: PASSED });
  });

  it('keeps a failed check too, with its problem', async () => {
    const failedCheck = { ...PASSED, ok: false, problem: 'Linting failed on Windows.' };
    checkProject.mockResolvedValue(failedCheck);
    await handler(IPC_CHANNELS.COMPUTERS_CHECK_QUEUE_PROJECT)({}, { nodeId: 'pc', repoRoot: '/work/repo' });
    expect(computers.list()[0]!.projects[PROJECT.key]).toEqual(failedCheck);
  });

  it('refuses a folder the queue has not worked in, without sending anything', async () => {
    const reply = await handler(IPC_CHANNELS.COMPUTERS_CHECK_QUEUE_PROJECT)({}, { nodeId: 'pc', repoRoot: '/home/other' });
    expect(reply).toMatchObject({ success: false, error: { code: 'COMPUTERS_CHECK_QUEUE_PROJECT_FAILED', message: 'The Plan Queue has not worked in that project.' } });
    expect(checkProject).not.toHaveBeenCalled();
  });

  it('records nothing when the computer can not be reached, and passes the reason on', async () => {
    checkProject.mockRejectedValue(new Error('The computer is away.'));
    const reply = await handler(IPC_CHANNELS.COMPUTERS_CHECK_QUEUE_PROJECT)({}, { nodeId: 'pc', repoRoot: '/work/repo' });
    expect(reply).toMatchObject({ success: false, error: { message: 'The computer is away.' } });
    expect(computers.list()[0]!.projects).toEqual({});
  });
});
