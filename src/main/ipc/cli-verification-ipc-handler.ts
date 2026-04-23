/**
 * CLI Verification IPC Handlers
 * Handles CLI detection and multi-CLI verification
 */

import { ipcMain, IpcMainInvokeEvent, BrowserWindow } from 'electron';
import { getLogger } from '../logging/logger';
import { IpcResponse } from '../../shared/types/ipc.types';
import { CliDetectionService, CliType, SUPPORTED_CLIS } from '../cli/cli-detection';
import { getCliUpdateService } from '../cli/cli-update-service';
import { getProviderDoctor } from '../providers/provider-doctor';
import { getCliVerificationCoordinator, CliVerificationConfig } from '../orchestration/cli-verification-extension';
import type { PersonalityType, SynthesisStrategy } from '../../shared/types/verification.types';
import type { WindowManager } from '../window-manager';
import { CopilotCliAdapter, CopilotModelInfo, COPILOT_DEFAULT_MODELS } from '../cli/adapters/copilot-cli-adapter';
import { PROVIDER_MODEL_LIST } from '../../shared/types/provider.types';
import type { ModelDisplayInfo } from '../../shared/types/provider.types';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  CliDetectAllPayloadSchema,
  CliDetectOnePayloadSchema,
  CliUpdateAllPayloadSchema,
  CliUpdateOnePayloadSchema,
  CliTestConnectionPayloadSchema,
  ProviderListModelsPayloadSchema,
  CliVerificationStartPayloadSchema,
  CliVerificationCancelPayloadSchema,
} from '@contracts/schemas/provider';


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

  // Helper to safely get the main window and send events
  const sendToRenderer = (channel: string, data: unknown): void => {
    const mainWindow = windowManager.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, data);
    } else {
      logger.warn('Cannot send to renderer: no main window available', { channel });
    }
  };

  // ============================================
  // CLI Detection Handlers
  // ============================================

  // Detect all CLIs
  ipcMain.handle(
    'cli:detect-all',
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(CliDetectAllPayloadSchema, payload, 'cli:detect-all');
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
    'cli:detect-one',
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(CliDetectOnePayloadSchema, payload, 'cli:detect-one');
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
    'cli:test-connection',
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(CliTestConnectionPayloadSchema, payload, 'cli:test-connection');
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
    'cli:diagnose-all',
    async (): Promise<IpcResponse> => {
      try {
        const doctor = getProviderDoctor();
        const providerMap: Record<CliType, string> = {
          claude: 'claude-cli',
          codex: 'codex-cli',
          gemini: 'gemini-cli',
          copilot: 'copilot',
          cursor: 'cursor',
          ollama: 'ollama',
        };

        const entries = await Promise.all(
          SUPPORTED_CLIS.map(async (cliType) => {
            const installs = await cliDetection.scanAllCliInstalls(cliType);
            const updatePlan = await getCliUpdateService().getUpdatePlan(cliType).catch((error) => ({
              cli: cliType,
              displayName: cliType,
              supported: false,
              reason: error instanceof Error ? error.message : String(error),
            }));
            const providerKey = providerMap[cliType];
            const diagnosis = providerKey
              ? await doctor.diagnose(providerKey).catch(() => null)
              : null;
            return {
              cli: cliType,
              installs,
              activePath: installs[0]?.path,
              activeVersion: installs[0]?.version,
              diagnosis,
              updatePlan,
            };
          }),
        );

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
    'cli:update-one',
    async (
      event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const authError = deps.ensureAuthorized(event, 'cli:update-one', payload);
        if (authError) return authError;

        const validated = validateIpcPayload(CliUpdateOnePayloadSchema, payload, 'cli:update-one');
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
    'cli:update-all',
    async (
      event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const authError = deps.ensureAuthorized(event, 'cli:update-all', payload);
        if (authError) return authError;

        validateIpcPayload(CliUpdateAllPayloadSchema, payload, 'cli:update-all');
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
    'cli:scan-all-installs',
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const type = typeof payload === 'string'
          ? payload
          : (payload as { type?: string } | undefined)?.type;
        if (!type || !SUPPORTED_CLIS.includes(type as CliType)) {
          throw new Error(`Unknown CLI type: ${type}`);
        }
        const installs = await cliDetection.scanAllCliInstalls(type as CliType);
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
    'cli:check',
    async (
      _event: IpcMainInvokeEvent,
      cliType: string
    ): Promise<IpcResponse> => {
      try {
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
    'copilot:list-models',
    async (): Promise<IpcResponse<CopilotModelInfo[]>> => {
      try {
        logger.info('Fetching Copilot models from CLI');
        const adapter = new CopilotCliAdapter();
        const models = await adapter.listAvailableModels();
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
  // Dynamically queries CLI when supported (Copilot), falls back to static lists
  ipcMain.handle(
    'provider:list-models',
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse<ModelDisplayInfo[]>> => {
      try {
        const validated = validateIpcPayload(ProviderListModelsPayloadSchema, payload, 'provider:list-models');
        const provider = validated.provider;

        logger.info('Listing models for provider', { provider });

        // Copilot: dynamic listing via SDK
        if (provider === 'copilot') {
          try {
            const adapter = new CopilotCliAdapter();
            const copilotModels = await adapter.listAvailableModels();
            const models: ModelDisplayInfo[] = copilotModels
              .filter(m => m.enabled !== false)
              .map(m => ({
                id: m.id,
                name: m.name,
                tier: classifyCopilotModelTier(m.id),
              }));
            logger.info('Fetched Copilot models dynamically', { count: models.length });
            return { success: true, data: models };
          } catch {
            // Fall through to static list
            logger.warn('Dynamic Copilot model fetch failed, using static list');
          }
        }

        // All other providers (and Copilot fallback): use static lists
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
    'verification:start-cli',
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(CliVerificationStartPayloadSchema, payload, 'verification:start-cli');
        logger.info('Starting verification', { id: validated.id, promptLength: validated.prompt?.length, config: validated.config });

        const config: CliVerificationConfig = {
          agentCount: validated.config.agentCount || 3,
          cliAgents: validated.config.cliAgents as CliType[] | undefined,
          synthesisStrategy: (validated.config.synthesisStrategy as SynthesisStrategy) || 'debate',
          personalities: validated.config.personalities as PersonalityType[],
          confidenceThreshold: validated.config.confidenceThreshold || 0.7,
          timeout: validated.config.timeout || 300000,
          maxDebateRounds: validated.config.maxDebateRounds || 4,
          preferCli: true,
          fallbackToApi: validated.config.fallbackToApi ?? true,
          mixedMode: validated.config.mixedMode ?? false,
        };

        // Start verification (async - result sent via events)
        // Pass the frontend's session ID so events use the same ID
        coordinator.startVerificationWithCli(
          { prompt: validated.prompt, context: validated.context, id: validated.id, attachments: validated.attachments },
          config
        ).then((result) => {
          sendToRenderer('verification:complete', {
            sessionId: validated.id,
            result,
          });
        }).catch((error) => {
          logger.error('Verification error', error instanceof Error ? error : undefined);
          sendToRenderer('verification:error', {
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
    'verification:cancel',
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(CliVerificationCancelPayloadSchema, payload, 'verification:cancel');
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
    'verification:cancel-all',
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

// ============================================
// Event Forwarding
// ============================================

type SendToRenderer = (channel: string, data: unknown) => void;

function setupCoordinatorEvents(
  coordinator: ReturnType<typeof getCliVerificationCoordinator>,
  sendToRenderer: SendToRenderer
): void {
  logger.info('Setting up coordinator event forwarding');

  // Forward verification events to renderer
  coordinator.on('verification:started', (data) => {
    logger.info('Forwarding verification:started', { data });
    sendToRenderer('verification:started', data);
  });

  coordinator.on('verification:agents-launching', (data) => {
    logger.info('Forwarding verification:agents-launching', { requestId: data.requestId, agentCount: data.agents?.length });
    // Forward individual agent starts
    // IMPORTANT: agentId format must match coordinator's format in runAgent()
    // Coordinator uses: `${request.id}-${agent.name.toLowerCase().replace(/\s+/g, '-')}-${index}`
    for (let index = 0; index < data.agents.length; index++) {
      const agent = data.agents[index];
      const agentId = `${data.requestId}-${agent.name.toLowerCase().replace(/\s+/g, '-')}-${index}`;
      const payload = {
        sessionId: data.requestId,
        agentId,
        name: agent.name,
        type: agent.type,
        personality: agent.personality,
      };
      logger.info('Sending verification:agent-start', payload);
      sendToRenderer('verification:agent-start', payload);
    }
  });

  // Track accumulated content per agent for final response
  const agentContent = new Map<string, string>();

  // Forward agent streaming events and track content
  coordinator.on('verification:agent-stream', (data) => {
    // Track content for agent-complete event
    const currentContent = agentContent.get(data.agentId) || '';
    agentContent.set(data.agentId, currentContent + (data.content || ''));

    // Forward to renderer - store expects 'chunk', not 'content'
    const payload = {
      sessionId: data.requestId,
      agentId: data.agentId,
      chunk: data.content,
    };
    logger.info('Sending verification:agent-stream', { agentId: data.agentId, chunkLength: (data.content || '').length });
    sendToRenderer('verification:agent-stream', payload);
  });

  // Forward agent complete events
  coordinator.on('verification:agent-complete', (data) => {
    // Store expects { sessionId, response: AgentResponse }
    const finalContent = data.totalContent || agentContent.get(data.agentId) || '';
    const payload = {
      sessionId: data.requestId,
      response: {
        agentId: data.agentId,
        agentIndex: 0,
        model: data.agentName || 'unknown',
        response: finalContent,
        keyPoints: [],
        confidence: data.success ? 1 : 0,
        duration: 0,
        tokens: data.tokens || 0,
        cost: 0,
        error: data.error,
      },
    };
    logger.info('Sending verification:agent-complete', { agentId: data.agentId, success: data.success, responseLength: finalContent.length });
    sendToRenderer('verification:agent-complete', payload);
    // Clean up tracked content
    agentContent.delete(data.agentId);
  });

  coordinator.on('verification:completed', (result) => {
    logger.info('Sending verification:complete', { sessionId: result.id, hasResult: !!result });
    sendToRenderer('verification:complete', {
      sessionId: result.id,
      result,
    });
  });

  coordinator.on('verification:error', (data) => {
    logger.info('Sending verification:error', { sessionId: data.requestId, error: data.error?.message });
    sendToRenderer('verification:error', {
      sessionId: data.requestId,
      error: data.error?.message || 'Unknown error',
    });
  });

  // Forward cancellation events
  coordinator.on('verification:cancelled', (data) => {
    sendToRenderer('verification:cancelled', {
      sessionId: data.verificationId,
      reason: data.reason,
      agentsCancelled: data.agentsCancelled,
    });
  });

  coordinator.on('verification:agent-cancelled', (data) => {
    sendToRenderer('verification:agent-cancelled', {
      sessionId: data.verificationId,
      agentId: data.agentId,
    });
  });

  coordinator.on('warning', (data) => {
    sendToRenderer('verification:warning', data);
  });
}

// ============================================
// Helpers
// ============================================

/**
 * Classify a Copilot model ID into a tier for display.
 * Based on model naming conventions from the Copilot SDK.
 */
function classifyCopilotModelTier(modelId: string): 'fast' | 'balanced' | 'powerful' {
  const id = modelId.toLowerCase();
  // Fast tier: mini, lite, haiku, flash variants
  if (id.includes('mini') || id.includes('lite') || id.includes('haiku') || id.includes('flash')) {
    return 'fast';
  }
  // Powerful tier: opus, o3, o1, pro variants
  if (id.includes('opus') || id === 'o3' || id === 'o1' || id.includes('-pro')) {
    return 'powerful';
  }
  // Everything else: balanced
  return 'balanced';
}
