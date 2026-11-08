/**
 * The Computers page's view of the test machines: their choices, and where today's test runs and checks went. The
 * test machines' own file is the record (see src/main/computers/test-machine-file.ts); paired computers' choices
 * are the `computers` setting, which the page changes through the settings store.
 */
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../../shared/types/ipc.types';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import { ComputersChangeTestMachinePayloadSchema } from '@contracts/schemas/remote-node';
import {
  changeTestMachine,
  readRunLog,
  readTestMachines,
  summariseWorkToday,
} from '../../computers/test-machine-file';

function failed(code: string, error: unknown): IpcResponse {
  return { success: false, error: { code, message: (error as Error).message, timestamp: Date.now() } };
}

export function registerComputersHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.COMPUTERS_GET_TEST_MACHINE, async (): Promise<IpcResponse> => {
    try {
      const testMachines = readTestMachines();
      return { success: true, data: { testMachines, today: testMachines.length ? summariseWorkToday(readRunLog(), Date.now()) : null } };
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
}
