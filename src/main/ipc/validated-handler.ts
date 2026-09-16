import { z } from 'zod';
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { ErrorInfo } from '@contracts/types/transport';
import { getLogger } from '../logging/logger';

const logger = getLogger('IPC');

export interface IpcResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: ErrorInfo;
}

export interface ValidatedHandlerOptions {
  ensureTrustedSender?: (
    event: IpcMainInvokeEvent,
    channel: string,
  ) => IpcResponse | null;
  errorCode?: string;
}

/**
 * Creates a validated IPC handler that:
 * 1. Validates payload against Zod schema
 * 2. Wraps execution in try/catch with structured errors
 * 3. Logs validation failures
 */
export function validatedHandler<TInput, TOutput = unknown>(
  channel: string,
  schema: z.ZodSchema<TInput>,
  fn: (validated: TInput, event: IpcMainInvokeEvent) => Promise<IpcResponse<TOutput>>,
  options: ValidatedHandlerOptions = {},
): (event: IpcMainInvokeEvent, payload: unknown) => Promise<IpcResponse<TOutput>> {
  return async (event: IpcMainInvokeEvent, payload: unknown) => {
    try {
      const trustError = options.ensureTrustedSender?.(event, channel);
      if (trustError) {
        return trustError as IpcResponse<TOutput>;
      }
      const result = schema.safeParse(payload);
      if (!result.success) {
        const errors = result.error.issues
          .map((e) => `${e.path.join('.')}: ${e.message}`)
          .join('; ');
        logger.warn(`IPC validation failed for ${channel}`, { errors });
        return {
          success: false,
          error: { code: 'VALIDATION_FAILED', message: `Validation failed for ${channel}: ${errors}`, timestamp: Date.now() },
        };
      }
      return await fn(result.data, event);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`IPC handler error for ${channel}`, error instanceof Error ? error : undefined);
      return {
        success: false,
        error: {
          code: options.errorCode ?? `${channel}_FAILED`,
          message,
          timestamp: Date.now(),
        },
      };
    }
  };
}

/**
 * Shared IPC registration: trust check + Zod validation + structured errors.
 * New channels should use this instead of a local `ipcMain.handle` wrapper.
 */
export function registerValidatedIpcHandler<TInput, TOutput = unknown>(
  channel: string,
  schema: z.ZodSchema<TInput>,
  fn: (validated: TInput, event: IpcMainInvokeEvent) => Promise<IpcResponse<TOutput>>,
  options: ValidatedHandlerOptions = {},
): void {
  ipcMain.handle(channel, validatedHandler(channel, schema, fn, options));
}
