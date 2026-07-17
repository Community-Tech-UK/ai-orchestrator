import { ipcMain, shell } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '@contracts/channels';
import { validatedHandler, type IpcResponse } from '../validated-handler';
import { getCliUpdatePollService, type CliUpdatePollService } from '../../cli/cli-update-poll-service';
import { getDoctorService } from '../../diagnostics/doctor-service';
import { getInstructionDiagnosticsService } from '../../diagnostics/instruction-diagnostics-service';
import { getOperatorArtifactExporter } from '../../diagnostics/operator-artifact-exporter';
import { getSkillDiagnosticsService } from '../../diagnostics/skill-diagnostics-service';
import { getSettingsManager } from '../../core/config/settings-manager';
import { getLogger } from '../../logging/logger';
import type { InstanceManager } from '../../instance/instance-manager';
import type { WindowManager } from '../../window-manager';

const logger = getLogger('DiagnosticsHandlers');

export interface DiagnosticsHandlerDependencies {
  /** Needed for the WS8 per-instance context attribution / cache analytics reads. */
  instanceManager?: InstanceManager;
}

const WorkingDirectorySchema = z.string().min(1).max(4000).optional();
const DoctorReportPayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
  force: z.boolean().optional(),
}).optional().default({});

const InstructionDiagnosticsPayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
  broadRootFileThreshold: z.number().int().min(0).max(1_000_000).optional(),
}).optional().default({});

const ExportArtifactPayloadSchema = z.object({
  sessionId: z.string().min(1).max(500).optional(),
  workingDirectory: WorkingDirectorySchema,
  force: z.boolean().optional(),
}).optional().default({});

const RevealBundlePayloadSchema = z.object({
  bundlePath: z.string().min(1).max(4000),
});

const InstanceScopedPayloadSchema = z.object({
  instanceId: z.string().min(1).max(500),
});

let cliUpdateDeltaCleanup: (() => void) | null = null;

export function registerDiagnosticsHandlers(deps: DiagnosticsHandlerDependencies = {}): void {
  ipcMain.handle(
    IPC_CHANNELS.DIAGNOSTICS_GET_DOCTOR_REPORT,
    validatedHandler(
      IPC_CHANNELS.DIAGNOSTICS_GET_DOCTOR_REPORT,
      DoctorReportPayloadSchema,
      async (payload): Promise<IpcResponse> => ({
        success: true,
        data: await getDoctorService().getReport(payload),
      }),
    ),
  );

  ipcMain.handle(
    IPC_CHANNELS.DIAGNOSTICS_GET_SKILL_DIAGNOSTICS,
    async (): Promise<IpcResponse> => {
      try {
        return {
          success: true,
          data: await getSkillDiagnosticsService().collect(),
        };
      } catch (error) {
        return toErrorResponse('DIAGNOSTICS_GET_SKILL_DIAGNOSTICS_FAILED', error);
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.DIAGNOSTICS_GET_INSTRUCTION_DIAGNOSTICS,
    validatedHandler(
      IPC_CHANNELS.DIAGNOSTICS_GET_INSTRUCTION_DIAGNOSTICS,
      InstructionDiagnosticsPayloadSchema,
      async (payload): Promise<IpcResponse> => {
        if (!payload.workingDirectory) {
          return {
            success: true,
            data: [],
          };
        }

        return {
          success: true,
          data: await getInstructionDiagnosticsService().collect({
            workingDirectory: payload.workingDirectory,
            broadRootFileThreshold:
              payload.broadRootFileThreshold ?? getSettingsManager().get('broadRootFileThreshold'),
          }),
        };
      },
    ),
  );

  ipcMain.handle(
    IPC_CHANNELS.DIAGNOSTICS_EXPORT_ARTIFACT_BUNDLE,
    validatedHandler(
      IPC_CHANNELS.DIAGNOSTICS_EXPORT_ARTIFACT_BUNDLE,
      ExportArtifactPayloadSchema,
      async (payload): Promise<IpcResponse> => ({
        success: true,
        data: await getOperatorArtifactExporter().export(payload),
      }),
    ),
  );

  ipcMain.handle(
    IPC_CHANNELS.DIAGNOSTICS_REVEAL_BUNDLE,
    validatedHandler(
      IPC_CHANNELS.DIAGNOSTICS_REVEAL_BUNDLE,
      RevealBundlePayloadSchema,
      async (payload): Promise<IpcResponse> => {
        shell.showItemInFolder(payload.bundlePath);
        return { success: true, data: { ok: true } };
      },
    ),
  );

  ipcMain.handle(
    IPC_CHANNELS.CONTEXT_ATTRIBUTION_GET,
    validatedHandler(
      IPC_CHANNELS.CONTEXT_ATTRIBUTION_GET,
      InstanceScopedPayloadSchema,
      async (payload): Promise<IpcResponse> => {
        const instance = deps.instanceManager?.getInstance(payload.instanceId);
        if (!instance) {
          return toErrorResponse(
            'CONTEXT_ATTRIBUTION_UNKNOWN_INSTANCE',
            new Error(`Unknown instance: ${payload.instanceId}`),
          );
        }
        /* eslint-disable @typescript-eslint/no-require-imports */
        const { computeContextAttribution } = require('../../context/context-attribution-service') as typeof import('../../context/context-attribution-service');
        const { getBrowserGatewayRpcSocketPath } = require('../../browser-gateway') as typeof import('../../browser-gateway');
        const { getDesktopGatewayInjectionState } = require('../../desktop-gateway') as typeof import('../../desktop-gateway');
        const { isOrchestratorRuntimeInjectionProvider } = require('../../../shared/types/mcp-scopes.types') as typeof import('../../../shared/types/mcp-scopes.types');
        /* eslint-enable @typescript-eslint/no-require-imports */
        const settings = getSettingsManager().getAll();
        const isRemote = instance.executionLocation?.type === 'remote';
        const browserInjected = !isRemote && Boolean(getBrowserGatewayRpcSocketPath());
        const report = await computeContextAttribution({
          instance,
          mcpProfile: {
            browserGateway: browserInjected
              ? (settings.browserMcpToolDeferral ? 'deferred' : 'eager')
              : 'off',
            orchestratorTools: isOrchestratorRuntimeInjectionProvider(instance.provider),
            codemem: !isRemote && settings.codememEnabled,
            computerUse:
              !isRemote
              && settings.computerUseEnabled
              && getDesktopGatewayInjectionState().supported,
          },
        });
        return { success: true, data: report };
      },
    ),
  );

  ipcMain.handle(
    IPC_CHANNELS.CACHE_ANALYTICS_GET,
    validatedHandler(
      IPC_CHANNELS.CACHE_ANALYTICS_GET,
      InstanceScopedPayloadSchema,
      async (payload): Promise<IpcResponse> => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getCacheAnalyticsService } = require('../../context/cache-analytics-service') as typeof import('../../context/cache-analytics-service');
        return {
          success: true,
          data: getCacheAnalyticsService().getReport(payload.instanceId),
        };
      },
    ),
  );

  ipcMain.handle(
    IPC_CHANNELS.CLI_UPDATE_PILL_GET_STATE,
    async (): Promise<IpcResponse> => ({
      success: true,
      data: getCliUpdatePollService().getState(),
    }),
  );

  ipcMain.handle(
    IPC_CHANNELS.CLI_UPDATE_PILL_REFRESH,
    async (): Promise<IpcResponse> => {
      try {
        return {
          success: true,
          data: await getCliUpdatePollService().refresh(),
        };
      } catch (error) {
        return toErrorResponse('CLI_UPDATE_PILL_REFRESH_FAILED', error);
      }
    },
  );

  logger.info('Diagnostics IPC handlers registered');
}

export function bridgeCliUpdatePillDeltaToWindow(
  windowManager: WindowManager,
  pollService: CliUpdatePollService = getCliUpdatePollService(),
): void {
  cliUpdateDeltaCleanup?.();
  cliUpdateDeltaCleanup = pollService.onChange((state) => {
    windowManager.sendToRenderer(IPC_CHANNELS.CLI_UPDATE_PILL_DELTA, state);
  });
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
