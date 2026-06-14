import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  CampaignGetPayloadSchema,
  CampaignHaltPayloadSchema,
  CampaignListPayloadSchema,
  CampaignResumePayloadSchema,
  CampaignStartPayloadSchema,
  CampaignValidatePayloadSchema,
} from '@contracts/schemas/campaign';
import { getCampaignCoordinator, validateCampaignSpec } from '../../orchestration/campaign-coordinator';
import type { CampaignSpec } from '../../orchestration/campaign.types';
import type { WindowManager } from '../../window-manager';

function campaignRunToDto(run: ReturnType<ReturnType<typeof getCampaignCoordinator>['getCampaign']>) {
  if (!run) return null;
  return {
    id: run.id,
    spec: run.spec,
    status: run.status,
    nodeRuns: [...run.nodeRuns.values()],
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    pausedReason: run.pausedReason,
  };
}

export function registerCampaignHandlers(deps: { windowManager: WindowManager }): void {
  const coordinator = getCampaignCoordinator();

  // Forward campaign events to renderer, attaching the full campaign DTO for
  // events that carry a campaignId so the store can do a full in-place update.
  const forward = (event: string) => {
    coordinator.on(event, (data: unknown) => {
      const campaignId = (data as { campaignId?: string } | null)?.campaignId;
      const campaign = campaignId ? campaignRunToDto(coordinator.getCampaign(campaignId)) : null;
      deps.windowManager.sendToRenderer(IPC_CHANNELS.CAMPAIGN_STATE_CHANGED, { event, data, campaignId, campaign });
    });
  };
  forward('campaign:started');
  forward('campaign:paused');
  forward('campaign:resumed');
  forward('campaign:completed');
  forward('campaign:failed');
  forward('campaign:halted');
  forward('campaign:node-started');
  forward('campaign:node-terminal');
  forward('campaign:node-skipped');
  forward('campaign:state-changed');

  ipcMain.handle(
    IPC_CHANNELS.CAMPAIGN_VALIDATE,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(CampaignValidatePayloadSchema, payload, 'CAMPAIGN_VALIDATE');
        const result = validateCampaignSpec(validated as CampaignSpec);
        return { success: true, data: result };
      } catch (error) {
        return { success: false, error: { code: 'CAMPAIGN_VALIDATE_FAILED', message: (error as Error).message, timestamp: Date.now() } };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CAMPAIGN_START,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(CampaignStartPayloadSchema, payload, 'CAMPAIGN_START');
        const run = await coordinator.startCampaign(validated as CampaignSpec);
        return { success: true, data: { campaign: campaignRunToDto(run) } };
      } catch (error) {
        return { success: false, error: { code: 'CAMPAIGN_START_FAILED', message: (error as Error).message, timestamp: Date.now() } };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CAMPAIGN_GET,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(CampaignGetPayloadSchema, payload, 'CAMPAIGN_GET');
        const run = coordinator.getCampaign(validated.campaignId);
        return { success: true, data: { campaign: campaignRunToDto(run) } };
      } catch (error) {
        return { success: false, error: { code: 'CAMPAIGN_GET_FAILED', message: (error as Error).message, timestamp: Date.now() } };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CAMPAIGN_LIST,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(CampaignListPayloadSchema, payload ?? {}, 'CAMPAIGN_LIST');
        const runs = coordinator.listCampaigns(validated.limit);
        return { success: true, data: { campaigns: runs.map((r) => campaignRunToDto(r)) } };
      } catch (error) {
        return { success: false, error: { code: 'CAMPAIGN_LIST_FAILED', message: (error as Error).message, timestamp: Date.now() } };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CAMPAIGN_HALT,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(CampaignHaltPayloadSchema, payload, 'CAMPAIGN_HALT');
        coordinator.haltCampaignByOperator(validated.campaignId);
        return { success: true, data: null };
      } catch (error) {
        return { success: false, error: { code: 'CAMPAIGN_HALT_FAILED', message: (error as Error).message, timestamp: Date.now() } };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CAMPAIGN_RESUME,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(CampaignResumePayloadSchema, payload, 'CAMPAIGN_RESUME');
        await coordinator.resumeCampaign(validated.campaignId);
        return { success: true, data: null };
      } catch (error) {
        return { success: false, error: { code: 'CAMPAIGN_RESUME_FAILED', message: (error as Error).message, timestamp: Date.now() } };
      }
    },
  );
}
