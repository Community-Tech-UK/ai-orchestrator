import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  CampaignGetPayloadSchema,
  CampaignHaltPayloadSchema,
  CampaignImportPlanPreviewPayloadSchema,
  CampaignListPayloadSchema,
  CampaignResumePayloadSchema,
  CampaignStartPayloadSchema,
  CampaignValidatePayloadSchema,
} from '@contracts/schemas/campaign';
import path from 'path';
import { getCampaignCoordinator, validateCampaignSpec } from '../../orchestration/campaign-coordinator';
import {
  buildCampaignFromPlan,
  computePlanSourceDigest,
} from '../../orchestration/campaign-plan-import';
import { readUtf8FileHead } from '../../orchestration/bounded-file-read';
import { isInsideOrEqual } from '../../util/path-helpers';
import type { CampaignSpec } from '../../orchestration/campaign.types';
import type { WindowManager } from '../../window-manager';

/** WS7/WS8 shared plan read: path-safe, bounded (plans are text files). */
const CAMPAIGN_PLAN_MAX_BYTES = 1_048_576;
async function readWorkspacePlan(workspaceCwd: string, planFile: string): Promise<string> {
  const resolved = path.resolve(workspaceCwd, planFile);
  if (!isInsideOrEqual(workspaceCwd, resolved)) {
    throw new Error('planFile must resolve inside the workspace');
  }
  return (await readUtf8FileHead(resolved, CAMPAIGN_PLAN_MAX_BYTES)).text;
}

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
    IPC_CHANNELS.CAMPAIGN_IMPORT_PLAN_PREVIEW,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          CampaignImportPlanPreviewPayloadSchema, payload, 'CAMPAIGN_IMPORT_PLAN_PREVIEW',
        );
        const planText = await readWorkspacePlan(validated.workspaceCwd, validated.planFile);
        // WS8: build ONLY — import never auto-starts. The renderer shows the
        // nodes, per-node caps, aggregate worst-case estimate, sequential
        // policy, and final gate before the user presses the start control.
        const result = buildCampaignFromPlan({
          workspaceCwd: validated.workspaceCwd,
          planFile: validated.planFile,
          planText,
          baseLoop: validated.baseLoop,
          now: Date.now(),
        });
        return { success: true, data: result };
      } catch (error) {
        return { success: false, error: { code: 'CAMPAIGN_IMPORT_PREVIEW_FAILED', message: (error as Error).message, timestamp: Date.now() } };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CAMPAIGN_START,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(CampaignStartPayloadSchema, payload, 'CAMPAIGN_START');
        const spec = validated as CampaignSpec;
        // WS8 staleness check: a plan-imported spec carries the preview-time
        // digest; re-read and re-hash the plan NOW and refuse to run against
        // changed scopes — the user must re-preview.
        if (spec.sourceRef && spec.sourceDigest) {
          const workspaceCwd = spec.nodes[0]?.loopConfig.workspaceCwd;
          if (workspaceCwd) {
            const currentText = await readWorkspacePlan(workspaceCwd, spec.sourceRef);
            const currentDigest = computePlanSourceDigest(currentText);
            if (currentDigest !== spec.sourceDigest) {
              return {
                success: false,
                error: {
                  code: 'CAMPAIGN_PLAN_STALE',
                  message: `The plan ${spec.sourceRef} changed since this campaign was previewed. `
                    + 'Re-import the plan to rebuild the campaign against its current scopes.',
                  timestamp: Date.now(),
                },
              };
            }
          }
        }
        const run = await coordinator.startCampaign(spec);
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
