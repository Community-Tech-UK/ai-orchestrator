/**
 * IPC handlers for the RTK token-savings panel.
 *
 * Exposes a read-only window onto RTK's local SQLite tracking DB and the
 * runtime status (binary path, version, feature flag). The renderer uses
 * these to render the savings widget under Settings → Performance.
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import {
  RtkHistoryPayloadSchema,
  RtkSummaryPayloadSchema,
} from '@contracts/schemas/rtk';
import { validatedHandler, type IpcResponse } from '../validated-handler';
import { getRtkRuntime } from '../../cli/rtk/rtk-runtime';
import {
  getRtkTrackingReader,
  RtkTrackingReader,
} from '../../cli/rtk/rtk-tracking-reader';
import { getSettingsManager } from '../../core/config/settings-manager';
import { getLogger } from '../../logging/logger';

const logger = getLogger('RtkHandlers');

/**
 * Resolve the singleton tracking reader. Pulled out so we can unit-test
 * handlers with a stubbed reader by replacing `getRtkTrackingReader`.
 */
function getReader(): RtkTrackingReader {
  return getRtkTrackingReader();
}

export function registerRtkHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.RTK_GET_STATUS,
    async (): Promise<IpcResponse> => {
      try {
        const settings = getSettingsManager();
        const enabled = Boolean(settings.get('rtkEnabled'));
        const bundledOnly = Boolean(settings.get('rtkBundledOnly'));
        const runtime = getRtkRuntime({ bundledOnly });
        const reader = getReader();
        return {
          success: true,
          data: {
            enabled,
            available: runtime.isAvailable(),
            binarySource: runtime.binarySource(),
            version: runtime.version(),
            trackingDbPath: reader.getDbPath(),
            trackingDbAvailable: reader.isAvailable(),
          },
        };
      } catch (error) {
        return toErrorResponse('RTK_GET_STATUS_FAILED', error);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.RTK_GET_SUMMARY,
    validatedHandler(
      IPC_CHANNELS.RTK_GET_SUMMARY,
      RtkSummaryPayloadSchema,
      async (payload): Promise<IpcResponse> => ({
        success: true,
        data: getReader().getSummary({
          projectPath: payload.projectPath,
          sinceMs: payload.sinceMs,
          topN: payload.topN,
        }),
      }),
    ),
  );

  ipcMain.handle(
    IPC_CHANNELS.RTK_GET_HISTORY,
    validatedHandler(
      IPC_CHANNELS.RTK_GET_HISTORY,
      RtkHistoryPayloadSchema,
      async (payload): Promise<IpcResponse> => ({
        success: true,
        data: getReader().getRecentHistory({
          projectPath: payload.projectPath,
          limit: payload.limit,
        }),
      }),
    ),
  );

  logger.info('RTK IPC handlers registered');
}

function toErrorResponse(code: string, error: unknown): IpcResponse {
  return {
    success: false,
    error: {
      code,
      message: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    },
  };
}
