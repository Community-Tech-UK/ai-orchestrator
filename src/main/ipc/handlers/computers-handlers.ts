/**
 * The Computers page's view of the test machines: their choices, and where today's test runs and checks went. The
 * test machines' own file is the record (see src/main/computers/test-machine-file.ts); paired computers' choices
 * are the `computers` setting, which the page changes through the settings store. Plan Queue jobs on a computer are
 * kept apart, in src/main/computers/queue-job-computers.ts: only this page changes them.
 */
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../../shared/types/ipc.types';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import {
  ComputersChangeQueueJobsPayloadSchema,
  ComputersChangeTestMachinePayloadSchema,
  ComputersCheckQueueProjectPayloadSchema,
  ComputersSetUseThisMacPayloadSchema,
} from '@contracts/schemas/remote-node';
import type { QueueJobProject, QueueJobsPageView } from '../../../shared/types/plan-queue-computers-page.types';
import { getPlanQueueCoordinator } from '../../plan-queue/plan-queue-coordinator';
import { currentBranch } from '../../plan-queue/plan-queue-git';
import { RemoteQueueJobs } from '../../plan-queue/remote/queue-job-remote';
import { getQueueJobComputers, type QueueJobComputers } from '../../computers/queue-job-computers';
import { knownQueueProjects, remoteProjectChecker, type QueueProjectChecker } from '../../computers/queue-job-projects';
import {
  changeTestMachine,
  readRunLog,
  readTestMachines,
  readUseThisMac,
  setUseThisMac,
  summariseWorkToday,
} from '../../computers/test-machine-file';

function failed(code: string, error: unknown): IpcResponse {
  return { success: false, error: { code, message: (error as Error).message, timestamp: Date.now() } };
}

/** The most runs read to find the repositories the queue has worked in. */
const RUNS_READ_FOR_PROJECTS = 50;

export interface ComputersHandlerDeps {
  computers: () => QueueJobComputers;
  /** The repositories of the Plan Queue's runs, newest first. */
  projects: () => QueueJobProject[];
  checkProject: QueueProjectChecker;
}

function defaultDeps(): ComputersHandlerDeps {
  // Made on first use, so nothing the remote send needs has to be ready when the handlers are registered. This is the
  // one place the Computers page reaches the remote send: use the queue's own instance here if it keeps one.
  let checker: QueueProjectChecker | null = null;
  return {
    computers: getQueueJobComputers,
    projects: () => {
      const coordinator = getPlanQueueCoordinator();
      return coordinator.isInitialized() ? knownQueueProjects(coordinator.listRunDtos(RUNS_READ_FOR_PROJECTS)) : [];
    },
    checkProject: (nodeId, repoRoot) => {
      checker ??= remoteProjectChecker(new RemoteQueueJobs(), getQueueJobComputers(), currentBranch);
      return checker(nodeId, repoRoot);
    },
  };
}

export function registerComputersHandlers(deps: ComputersHandlerDeps = defaultDeps()): void {
  ipcMain.handle(IPC_CHANNELS.COMPUTERS_GET_TEST_MACHINE, async (): Promise<IpcResponse> => {
    try {
      const testMachines = readTestMachines();
      return { success: true, data: { testMachines, useThisMac: readUseThisMac(), today: testMachines.length ? summariseWorkToday(readRunLog(), Date.now()) : null } };
    } catch (error) {
      return failed('COMPUTERS_GET_TEST_MACHINE_FAILED', error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.COMPUTERS_CHANGE_TEST_MACHINE, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const { host, change } = ComputersChangeTestMachinePayloadSchema.parse(payload);
      return { success: true, data: { testMachine: changeTestMachine(host, change) } };
    } catch (error) {
      return failed('COMPUTERS_CHANGE_TEST_MACHINE_FAILED', error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.COMPUTERS_GET_QUEUE_JOBS, async (): Promise<IpcResponse> => {
    try {
      return { success: true, data: { computers: deps.computers().list(), projects: deps.projects() } satisfies QueueJobsPageView };
    } catch (error) {
      return failed('COMPUTERS_GET_QUEUE_JOBS_FAILED', error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.COMPUTERS_CHANGE_QUEUE_JOBS, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const { nodeId, change } = ComputersChangeQueueJobsPayloadSchema.parse(payload);
      const computers = deps.computers();
      if (change.jobsAtOnce !== undefined) computers.setJobsAtOnce(nodeId, change.jobsAtOnce);
      if (change.takesJobs !== undefined) computers.setTakesJobs(nodeId, change.takesJobs);
      return { success: true, data: { computers: computers.list() } };
    } catch (error) {
      return failed('COMPUTERS_CHANGE_QUEUE_JOBS_FAILED', error);
    }
  });

  /** Only a repository the queue has worked in is checked, so the page can't send any other folder to a computer. */
  ipcMain.handle(IPC_CHANNELS.COMPUTERS_CHECK_QUEUE_PROJECT, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const { nodeId, repoRoot } = ComputersCheckQueueProjectPayloadSchema.parse(payload);
      const project = deps.projects().find(entry => entry.repoRoot === repoRoot);
      if (!project) throw new Error('The Plan Queue has not worked in that project.');
      const computers = deps.computers();
      computers.recordProjectCheck(nodeId, project.key, await deps.checkProject(nodeId, repoRoot));
      return { success: true, data: { computers: computers.list() } };
    } catch (error) {
      return failed('COMPUTERS_CHECK_QUEUE_PROJECT_FAILED', error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.COMPUTERS_SET_USE_THIS_MAC, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const { useThisMac } = ComputersSetUseThisMacPayloadSchema.parse(payload);
      return { success: true, data: { useThisMac: setUseThisMac(useThisMac) } };
    } catch (error) {
      return failed('COMPUTERS_SET_USE_THIS_MAC_FAILED', error);
    }
  });
}
