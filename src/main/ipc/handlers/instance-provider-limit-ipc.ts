import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  InstanceProviderLimitResumeNowPayloadSchema,
  InstanceProviderLimitCancelPayloadSchema,
  InstanceFailoverNowPayloadSchema,
  InstanceAuthRepairRetryPayloadSchema,
  InstanceAuthRepairCancelPayloadSchema,
} from '@contracts/schemas/instance';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import { getInstanceProviderLimitHandler } from '../../instance/instance-provider-limit-handler';
import { getInstanceAuthRepairHandler } from '../../instance/instance-auth-repair-handler';
import { getLoopCoordinator } from '../../orchestration/loop-coordinator';
import type { InstanceManager } from '../../instance/instance-manager';

/**
 * A loop parked on a provider limit paints its own `quota-park` waitReason onto
 * the loop's chat instance, so the composer banner (and its Resume button)
 * appears for a park the instance handler knows nothing about. Routing Resume
 * only to the instance handler made the button a guaranteed no-op for every
 * loop park: it cleared an instance park that was never registered, logged
 * "no message to re-send", and left the loop parked.
 *
 * Applies `act` to the loop parked on this chat, if there is one.
 */
function withParkedLoopForChat(
  instanceId: string,
  act: (coordinator: ReturnType<typeof getLoopCoordinator>, loopRunId: string) => boolean,
): boolean {
  let coordinator: ReturnType<typeof getLoopCoordinator>;
  try {
    coordinator = getLoopCoordinator();
  } catch {
    // No loop runtime in this process (headless/tests) — instance path only.
    return false;
  }
  const parked = coordinator
    .getActiveLoops()
    .find((loop) => loop.chatId === instanceId && loop.status === 'provider-limit');
  return parked ? act(coordinator, parked.id) : false;
}

/**
 * IPC handlers for the (opt-in) regular-session provider-limit park: resume a
 * parked session immediately, or cancel its scheduled auto-resume. Extracted
 * from instance-handlers.ts to keep that file within its size ceiling.
 */
export function registerInstanceProviderLimitHandlers(deps: { instanceManager?: InstanceManager } = {}): void {
  ipcMain.handle(
    IPC_CHANNELS.INSTANCE_PROVIDER_LIMIT_RESUME_NOW,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          InstanceProviderLimitResumeNowPayloadSchema,
          payload,
          'INSTANCE_PROVIDER_LIMIT_RESUME_NOW',
        );
        // Loop parks take precedence: when a loop owns this chat's banner the
        // instance handler has no park to clear and no turn to re-send.
        const resumedLoop = withParkedLoopForChat(validated.instanceId, (c, id) => c.resumeLoop(id));
        const resumed = resumedLoop
          || getInstanceProviderLimitHandler().resumeNow(validated.instanceId);
        return { success: true, data: { resumed, resumedLoop } };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'PROVIDER_LIMIT_RESUME_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.INSTANCE_PROVIDER_LIMIT_CANCEL,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          InstanceProviderLimitCancelPayloadSchema,
          payload,
          'INSTANCE_PROVIDER_LIMIT_CANCEL',
        );
        // The instance handler unconditionally clears the waitReason, which is
        // what removes the banner. For a loop-owned park that alone would hide
        // the countdown while the loop stayed parked with its auto-resume still
        // armed — the user would be surprised by a later iteration. Disarm the
        // loop's timer too, so a dismissed banner means what it says.
        const cancelledLoop = withParkedLoopForChat(
          validated.instanceId,
          (c, id) => c.cancelProviderLimitResume(id),
        );
        const cancelled = getInstanceProviderLimitHandler().cancel(validated.instanceId);
        return { success: true, data: { cancelled: cancelled || cancelledLoop, cancelledLoop } };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'PROVIDER_LIMIT_CANCEL_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  // In-session auth repair — banner actions for a session the provider signed
  // out. Retry re-probes and resumes; cancel just dismisses.
  ipcMain.handle(
    IPC_CHANNELS.INSTANCE_AUTH_REPAIR_RETRY,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          InstanceAuthRepairRetryPayloadSchema,
          payload,
          'INSTANCE_AUTH_REPAIR_RETRY',
        );
        const outcome = await getInstanceAuthRepairHandler().retryNow(validated.instanceId);
        return { success: true, data: outcome };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'AUTH_REPAIR_RETRY_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.INSTANCE_AUTH_REPAIR_CANCEL,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          InstanceAuthRepairCancelPayloadSchema,
          payload,
          'INSTANCE_AUTH_REPAIR_CANCEL',
        );
        const cancelled = getInstanceAuthRepairHandler().cancel(validated.instanceId);
        return { success: true, data: { cancelled } };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'AUTH_REPAIR_CANCEL_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  // WS7 Phase B — user-initiated provider switch (quota-park banner action).
  ipcMain.handle(
    IPC_CHANNELS.INSTANCE_FAILOVER_NOW,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          InstanceFailoverNowPayloadSchema,
          payload,
          'INSTANCE_FAILOVER_NOW',
        );
        if (!deps.instanceManager) {
          throw new Error('Instance manager unavailable');
        }
        const outcome = await deps.instanceManager.failoverNow(validated.instanceId);
        return { success: true, data: outcome };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'INSTANCE_FAILOVER_NOW_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );
}
