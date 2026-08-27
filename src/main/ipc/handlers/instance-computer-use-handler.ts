import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import { InstanceSetComputerUseModePayloadSchema } from '@contracts/schemas/instance';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import type { ComputerUseAutonomyLevel } from '../../../shared/types/desktop-gateway-settings.types';
import type { InstanceManager } from '../../instance/instance-manager';
import { getDesktopGatewayService } from '../../desktop-gateway/desktop-gateway-service';
import { validatedHandler } from '../validated-handler';

export function registerInstanceComputerUseHandler(deps: {
  instanceManager: InstanceManager;
  ensureTrustedSender?: (
    event: IpcMainInvokeEvent,
    channel: string,
  ) => IpcResponse | null;
  recordComputerUseModeChange?: (
    instanceId: string,
    previousMode: ComputerUseAutonomyLevel | undefined,
    nextMode: ComputerUseAutonomyLevel | undefined,
  ) => Promise<void>;
}): void {
  ipcMain.handle(
    IPC_CHANNELS.INSTANCE_SET_COMPUTER_USE_MODE,
    validatedHandler(
      IPC_CHANNELS.INSTANCE_SET_COMPUTER_USE_MODE,
      InstanceSetComputerUseModePayloadSchema,
      async (validated) => {
        const existing = deps.instanceManager.getInstance(validated.instanceId);
        if (!existing) {
          throw new Error(`Instance ${validated.instanceId} not found`);
        }
        const previousMode = existing.computerUseMode;
        const nextMode = validated.mode ?? undefined;
        const recordChange = deps.recordComputerUseModeChange
          ?? ((instanceId, previous, next) => getDesktopGatewayService().recordComputerUseModeChange(
            { instanceId },
            previous,
            next,
          ));
        await recordChange(validated.instanceId, previousMode, nextMode);
        const instance = deps.instanceManager.setComputerUseMode(validated.instanceId, nextMode);
        return {
          success: true,
          data: deps.instanceManager.serializeForIpc(instance),
        };
      },
      {
        ensureTrustedSender: deps.ensureTrustedSender,
        errorCode: 'SET_COMPUTER_USE_MODE_FAILED',
      },
    ),
  );
}
