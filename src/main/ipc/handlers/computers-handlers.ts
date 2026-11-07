/**
 * The Computers page's view of the test machine: its choices, and where today's test runs and checks went. The
 * test machine's own file is the record (see src/main/computers/test-machine-file.ts); paired computers' choices
 * are the `computers` setting, which the page changes through the settings store.
 */
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../../shared/types/ipc.types';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import { ComputersChangeTestMachinePayloadSchema } from '@contracts/schemas/remote-node';
import {
  changeTestMachine,
  readRunLog,
  readTestMachine,
  summariseWorkToday,
} from '../../computers/test-machine-file';

function failed(code: string, error: unknown): IpcResponse {
  return { success: false, error: { code, message: (error as Error).message, timestamp: Date.now() } };
}

export function registerComputersHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.COMPUTERS_GET_TEST_MACHINE, async (): Promise<IpcResponse> => {
    try {
      const testMachine = readTestMachine();
      return { success: true, data: { testMachine, today: testMachine ? summariseWorkToday(readRunLog(), Date.now()) : null } };
    } catch (error) {
      return failed('COMPUTERS_GET_TEST_MACHINE_FAILED', error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.COMPUTERS_CHANGE_TEST_MACHINE, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      return { success: true, data: { testMachine: changeTestMachine(ComputersChangeTestMachinePayloadSchema.parse(payload)) } };
    } catch (error) {
      return failed('COMPUTERS_CHANGE_TEST_MACHINE_FAILED', error);
    }
  });
}
