/**
 * CLI Verification IPC Handlers
 * Handles CLI detection and multi-CLI verification
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { getLogger } from '../logging/logger';
import { IpcResponse } from '../../shared/types/ipc.types';
import { CLI_REGISTRY, CliDetectionService, CliType, SUPPORTED_CLIS } from '../cli/cli-detection';
import { getCliUpdateService } from '../cli/cli-update-service';
import { getCliLatestVersionService } from '../cli/cli-latest-version';
import { isUpdateAvailable } from '../cli/semver';
import { getProviderDoctor } from '../providers/provider-doctor';
import { getCliVerificationCoordinator, CliVerificationConfig } from '../orchestration/cli-verification-extension';
import type { PersonalityType, SynthesisStrategy } from '../../shared/types/verification.types';
import type { WindowManager } from '../window-manager';
import { CopilotCliAdapter, CopilotModelInfo, COPILOT_DEFAULT_MODELS } from '../cli/adapters/copilot-cli-adapter';
import { CursorCliAdapter } from '../cli/adapters/cursor-cli-adapter';
import { PROVIDER_MODEL_LIST } from '../../shared/types/provider.types';
import type { ModelDisplayInfo } from '../../shared/types/provider.types';
import { validateIpcPayload } from '@contracts/schemas/common';
import { copilotModelInfosToDisplayInfo } from '../cli/adapters/copilot-cli-adapter.models';
import { setupCoordinatorEvents } from './cli-verification-event-forwarding';
import {
  CliDetectAllPayloadSchema,
  CliDetectOnePayloadSchema,
  CliUpdateAllPayloadSchema,
  CliUpdateOnePayloadSchema,
  CliTestConnectionPayloadSchema,
  ProviderListModelsPayloadSchema,
  CliVerificationStartPayloadSchema,
  CliVerificationCancelPayloadSchema,
  CliCheckPayloadSchema,
  CliScanAllInstallsPayloadSchema,
} from '@contracts/schemas/provider';
import { IPC_CHANNELS } from '@contracts/channels';


const logger = getLogger('CliVerification');

interface RegisterCliVerificationHandlersDeps {
  windowManager: WindowManager;
  ensureAuthorized: (
    event: IpcMainInvokeEvent,
    channel: string,
    payload: unknown
  ) => IpcResponse | null;
}

// ============================================
// Handler Registration
// ============================================

/**
 * Register CLI verification handlers.
 * Accepts WindowManager to lazily get the main window when needed,
 * since handlers are registered before the window is created.
 */
export function registerCliVerificationHandlers(
  deps: RegisterCliVerificationHandlersDeps
): void {
  const { windowManager } = deps;
  const cliDetection = CliDetectionService.getInstance();
  const coordinator = getCliVerificationCoordinator();

  // Route verification push events through the central thin-client event bus.
  const sendToRenderer = (channel: string, data: unknown): void => {
    windowManager.sendToRenderer(channel, data);
  };

  // ============================================
  // CLI Detection Handlers
  // ============================================

  // Detect all CLIs
  ipcMain.handle(
    IPC_CHANNELS.CLI_DETECT_ALL,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(CliDetectAllPayloadSchema, payload, IPC_CHANNELS.CLI_DETECT_ALL);
        const result = await cliDetection.detectAll(validated?.force);
        return {
          success: true,
          data: {
            timestamp: result.timestamp,
            detected: result.detected,
            available: result.available,
            unavailable: result.detected.filter((cli) => !cli.installed),
          },
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'CLI_DETECT_ALL_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Detect single CLI
  ipcMain.handle(
    IPC_CHANNELS.CLI_DETECT_ONE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(CliDetectOnePayloadSchema, payload, IPC_CHANNELS.CLI_DETECT_ONE);
        const cliInfo = await cliDetection.detectOne(validated.command as CliType);
        return { success: true, data: cliInfo };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'CLI_DETECT_ONE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Test CLI connection
  ipcMain.handle(
    IPC_CHANNELS.CLI_TEST_CONNECTION,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(CliTestConnectionPayloadSchema, payload, IPC_CHANNELS.CLI_TEST_CONNECTION);
        const cliInfo = await cliDetection.detectOne(validated.command as CliType);
        return {
          success: true,
          data: {
            success: cliInfo.installed && cliInfo.authenticated !== false,
            version: cliInfo.version,
            authenticated: cliInfo.authenticated,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'CLI_TEST_CONNECTION_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Scan every install of every supported CLI (with shadow detection) and
  // run the ProviderDoctor probes that apply.  Feeds the CLI Health tab.
  ipcMain.handle(
    IPC_CHANNELS.CLI_DIAGNOSE_ALL,
    async (): Promise<IpcResponse> => {
      try {
        const doctor = getProviderDoctor();
        const providerMap: Record<CliType, string> = {
          claude: 'claude-cli',
          codex: 'codex-cli',
          gemini: 'gemini-cli',
          antigravity: 'antigravity',
          copilot: 'copilot',
          cursor: 'cursor',
          grok: 'grok',
          opencode: 'opencode',
          ollama: 'ollama',
        };

        // Pinned so each card's install list, update plan and cli_shadow_check
        // row all read one scan, however long the probes between them take.
        const entries = await cliDetection.withPinnedInstallScans(() => Promise.all(
          SUPPORTED_CLIS.map(async (cliType) => {
            // Fresh scan for the card; the update plan and the doctor's
            // cli_shadow_check below reuse it, so every part of the card is
            // built from the same view of PATH.
            const installs = await cliDetection.scanAllCliInstalls(cliType, { forceRefresh: true });
            const updatePlan = await getCliUpdateService().getUpdatePlan(cliType).catch((error) => ({
              cli: cliType,
              // Registry name, not the raw id: CLI Health titles each card from
              // this, so a failed plan lookup must not rename "Grok Build" to
              // "grok" in the UI.
              displayName: CLI_REGISTRY[cliType]?.displayName ?? cliType,
              supported: false,
              reason: error instanceof Error ? error.message : String(error),
            }));
            const providerKey = providerMap[cliType];
            const diagnosis = providerKey
              ? await doctor.diagnose(providerKey).catch(() => null)
              : null;
            const activeVersion = installs[0]?.version;
            // Only query the registry for CLIs that are actually installed.
            // Shares the 1h-cached resolver with the update poller, so this is
            // usually a cache hit and fails soft to undefined ("unknown").
            const latestVersion =
              installs.length > 0
                ? (await getCliLatestVersionService().resolveLatestVersion(cliType)) ?? undefined
                : undefined;
            return {
              cli: cliType,
              installs,
              activePath: installs[0]?.path,
              activeVersion,
              latestVersion,
              updateAvailable: isUpdateAvailable(activeVersion, latestVersion),
              diagnosis,
              updatePlan,
            };
          }),
        ));

        return { success: true, data: { entries, timestamp: Date.now() } };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'CLI_DIAGNOSE_ALL_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  // Update one known CLI using fixed commands from CliUpdateService.
  ipcMain.handle(
    IPC_CHANNELS.CLI_UPDATE_ONE,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const authError = deps.ensureAuthorized(event, IPC_CHANNELS.CLI_UPDATE_ONE, payload);
        if (authError) return authError;

        const validated = validateIpcPayload(CliUpdateOnePayloadSchema, payload, IPC_CHANNELS.CLI_UPDATE_ONE);
        if (!SUPPORTED_CLIS.includes(validated.type as CliType)) {
          throw new Error(`Unknown CLI type: ${validated.type}`);
        }

        const result = await getCliUpdateService().updateOne(validated.type as CliType);
        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'CLI_UPDATE_ONE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  // Update every installed known CLI sequentially. Sequential execution avoids
  // package-manager lock contention and keeps output attributable per provider.
  ipcMain.handle(
    IPC_CHANNELS.CLI_UPDATE_ALL,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const authError = deps.ensureAuthorized(event, IPC_CHANNELS.CLI_UPDATE_ALL, payload);
        if (authError) return authError;

        validateIpcPayload(CliUpdateAllPayloadSchema, payload, IPC_CHANNELS.CLI_UPDATE_ALL);
        const results = await getCliUpdateService().updateAllInstalled();
        return { success: true, data: { results, timestamp: Date.now() } };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'CLI_UPDATE_ALL_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  // Scan all installs of a single CLI (without running any probes).
  ipcMain.handle(
    IPC_CHANNELS.CLI_SCAN_ALL_INSTALLS,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(CliScanAllInstallsPayloadSchema, payload, IPC_CHANNELS.CLI_SCAN_ALL_INSTALLS);
        const type = typeof validated === 'string' ? validated : validated.type;
        if (!SUPPORTED_CLIS.includes(type as CliType)) {
          throw new Error(`Unknown CLI type: ${type}`);
        }
        const installs = await cliDetection.scanAllCliInstalls(type as CliType, { forceRefresh: true });
        return { success: true, data: { cli: type, installs } };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'CLI_SCAN_ALL_INSTALLS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  // Check specific CLI (legacy handler for compatibility)
  ipcMain.handle(
    IPC_CHANNELS.CLI_CHECK,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const cliType = validateIpcPayload(CliCheckPayloadSchema, payload, IPC_CHANNELS.CLI_CHECK);
        const cliInfo = await cliDetection.detectOne(cliType as CliType);
        return { success: true, data: cliInfo };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'CLI_CHECK_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // ============================================
  // Copilot Model Handlers
  // ============================================

  // List available Copilot models (queries the CLI dynamically)
  ipcMain.handle(
    IPC_CHANNELS.COPILOT_LIST_MODELS,
    async (): Promise<IpcResponse<CopilotModelInfo[]>> => {
      try {
        logger.info('Fetching Copilot models from CLI');
        const adapter = new CopilotCliAdapter();
        const models = await adapter.listAvailableModels({ fallbackToStatic: false });
        logger.info('Fetched Copilot models from CLI', { count: models.length });
        return { success: true, data: models };
      } catch (error) {
        logger.error('Failed to fetch Copilot models', error instanceof Error ? error : undefined);
        // Return default models as fallback
        return {
          success: true,
          data: COPILOT_DEFAULT_MODELS,
        };
      }
    }
  );

  // ============================================
  // Generic Provider Model Listing
  // ============================================

  // List available models for any provider
  // Dynamically queries CLI when supported (Copilot/Cursor), falls back to static lists
  ipcMain.handle(
    IPC_CHANNELS.PROVIDER_LIST_MODELS,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse<ModelDisplayInfo[]>> => {
      try {
        const validated = validateIpcPayload(ProviderListModelsPayloadSchema, payload, IPC_CHANNELS.PROVIDER_LIST_MODELS);
        const provider = validated.provider;

        logger.info('Listing models for provider', { provider });

        // Copilot: dynamic listing via SDK
        if (provider === 'copilot') {
          try {
            const adapter = new CopilotCliAdapter();
            const copilotModels = await adapter.listAvailableModels({ fallbackToStatic: false });
            const models = copilotModelInfosToDisplayInfo(copilotModels);
            logger.info('Fetched Copilot models dynamically', { count: models.length });
            return { success: true, data: models };
          } catch {
            // Fall through to static list
            logger.warn('Dynamic Copilot model fetch failed, using static list');
          }
        }

        // Cursor: dynamic listing via `cursor-agent --list-models`
        if (provider === 'cursor') {
          try {
            const adapter = new CursorCliAdapter();
            const models = await adapter.listAvailableModels();
            logger.info('Fetched Cursor models dynamically', { count: models.length });
            return { success: true, data: models };
          } catch {
            // Fall through to static list
            logger.warn('Dynamic Cursor model fetch failed, using static list');
          }
        }

        // All other providers (and Copilot/Cursor fallback): use static lists
        const staticModels = PROVIDER_MODEL_LIST[provider] ?? [];
        logger.info('Returning static models for provider', { provider, count: staticModels.length });
        return { success: true, data: staticModels };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'LIST_MODELS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // ============================================
  // CLI Verification Handlers
  // ============================================

  // Set up event forwarding from coordinator to renderer
  setupCoordinatorEvents(coordinator, sendToRenderer);

  // Start CLI verification
  ipcMain.handle(
    IPC_CHANNELS.VERIFICATION_START_CLI,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(CliVerificationStartPayloadSchema, payload, IPC_CHANNELS.VERIFICATION_START_CLI);
        logger.info('Starting verification', { id: validated.id, promptLength: validated.prompt?.length, config: validated.config });

        const config: CliVerificationConfig = {
          agentCount: validated.config.agentCount || 1,
          cliAgents: validated.config.cliAgents as CliType[] | undefined,
          synthesisStrategy: (validated.config.synthesisStrategy as SynthesisStrategy) || 'merge',
          personalities: validated.config.personalities as PersonalityType[],
          confidenceThreshold: validated.config.confidenceThreshold || 0.7,
          timeout: validated.config.timeout || 300000,
          maxDebateRounds: validated.config.maxDebateRounds || 2,
          preferCli: true,
          fallbackToApi: validated.config.fallbackToApi ?? true,
          mixedMode: validated.config.mixedMode ?? false,
          ...(validated.config.earlyTermination ? { earlyTermination: validated.config.earlyTermination } : {}),
        };

        // Start verification (async - result sent via events)
        // Pass the frontend's session ID so events use the same ID
        coordinator.startVerificationWithCli(
          { prompt: validated.prompt, context: validated.context, id: validated.id, attachments: validated.attachments },
          config
        ).then((result) => {
          sendToRenderer(IPC_CHANNELS.VERIFICATION_COMPLETE, {
            sessionId: validated.id,
            result,
          });
        }).catch((error) => {
          logger.error('Verification error', error instanceof Error ? error : undefined);
          sendToRenderer(IPC_CHANNELS.VERIFICATION_ERROR, {
            sessionId: validated.id,
            error: (error as Error).message,
          });
        });

        return { success: true, data: { verificationId: validated.id } };
      } catch (error) {
        logger.error('Failed to start verification', error instanceof Error ? error : undefined);
        return {
          success: false,
          error: {
            code: 'VERIFY_CLI_START_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Cancel verification
  ipcMain.handle(
    IPC_CHANNELS.VERIFICATION_CANCEL,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(CliVerificationCancelPayloadSchema, payload, IPC_CHANNELS.VERIFICATION_CANCEL);
        const result = await coordinator.cancelVerification(validated.id);

        if (!result.success) {
          return {
            success: false,
            error: {
              code: 'VERIFY_CANCEL_NOT_FOUND',
              message: result.error || 'Verification not found',
              timestamp: Date.now(),
            },
          };
        }

        return {
          success: true,
          data: {
            verificationId: validated.id,
            agentsCancelled: result.agentsCancelled,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'VERIFY_CANCEL_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Cancel all verifications
  ipcMain.handle(
    IPC_CHANNELS.VERIFICATION_CANCEL_ALL,
    async (): Promise<IpcResponse> => {
      try {
        const result = await coordinator.cancelAllVerifications();

        return {
          success: result.success,
          data: {
            sessionsCancelled: result.sessionsCancelled,
            totalAgentsCancelled: result.totalAgentsCancelled,
            errors: result.errors,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'VERIFY_CANCEL_ALL_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );
}

export { setupCoordinatorEvents };
