/**
 * Renderer Telemetry IPC Handlers
 *
 * Two renderer→main observability paths:
 * - LOG_MESSAGE (invoke): structured log forwarding used by the renderer's
 *   global ErrorHandler. This channel previously had NO main-process handler,
 *   so forwarded renderer errors were silently rejected and never reached the
 *   log file.
 * - RENDERER_HEARTBEAT (send): high-frequency main-thread heartbeat feeding
 *   the freeze-detection monitor. Uses `ipcMain.on`, not `handle` — no
 *   response round-trip for a 0.5 Hz telemetry ping.
 */

import { ipcMain } from 'electron';
import type { IpcMainEvent } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import {
  RendererHeartbeatPayloadSchema,
  RendererLogMessagePayloadSchema,
} from '@contracts/schemas/observability';
import { getLogger } from '../../logging/logger';
import { getRendererHeartbeatMonitor } from '../../logging/renderer-heartbeat-monitor';
import { validatedHandler, type IpcResponse } from '../validated-handler';

const rendererLogger = getLogger('Renderer');

export function registerRendererTelemetryHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.LOG_MESSAGE,
    validatedHandler(
      IPC_CHANNELS.LOG_MESSAGE,
      RendererLogMessagePayloadSchema,
      async (payload): Promise<IpcResponse> => {
        const metadata = {
          ...(payload.metadata ?? {}),
          ...(payload.context ? { context: payload.context } : {}),
        };
        if (payload.level === 'error') {
          rendererLogger.error(payload.message, undefined, metadata);
        } else {
          rendererLogger[payload.level](payload.message, metadata);
        }
        return { success: true };
      },
    ),
  );

  ipcMain.on(IPC_CHANNELS.RENDERER_HEARTBEAT, (event: IpcMainEvent, payload: unknown) => {
    const parsed = RendererHeartbeatPayloadSchema.safeParse(payload);
    if (!parsed.success) return; // telemetry — never throw back at the renderer
    const senderId = event.sender.id;
    const monitor = getRendererHeartbeatMonitor();
    if (!monitor.isTracking(senderId)) {
      event.sender.once('destroyed', () => monitor.forget(senderId));
    }
    monitor.beat(senderId, parsed.data);
  });
}
