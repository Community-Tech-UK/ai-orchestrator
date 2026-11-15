/**
 * The two small helpers every Plan Queue IPC handler file uses: a failure in the shared response shape, and a handler
 * registration that turns a thrown error into one.
 */
import { ipcMain, IpcMainInvokeEvent } from 'electron';
import type { IpcResponse } from '../../../shared/types/ipc.types';

export function fail(code: string, error: unknown): IpcResponse {
  return { success: false, error: { code, message: (error as Error).message, timestamp: Date.now() } };
}

export function handle(channel: string, code: string, fn: (payload: unknown) => Promise<unknown> | unknown): void {
  ipcMain.handle(channel, async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
    try {
      return { success: true, data: await fn(payload) };
    } catch (error) {
      return fail(code, error);
    }
  });
}
