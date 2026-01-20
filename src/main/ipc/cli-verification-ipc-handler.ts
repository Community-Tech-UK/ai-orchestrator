/**
 * CLI Verification IPC Handlers
 * Handles CLI detection and multi-CLI verification
 */

import { ipcMain, IpcMainInvokeEvent, BrowserWindow } from 'electron';
import { IpcResponse } from '../../shared/types/ipc.types';
import { CliDetectionService, CliInfo, CliType } from '../cli/cli-detection';
import { getCliVerificationCoordinator, CliVerificationConfig } from '../orchestration/cli-verification-extension';
import type { PersonalityType, SynthesisStrategy } from '../../shared/types/verification.types';

// ============================================
// Types
// ============================================

interface CliDetectAllPayload {
  force?: boolean;
}

interface CliDetectOnePayload {
  command: string;
}

interface CliTestConnectionPayload {
  command: string;
}

interface CliVerificationStartPayload {
  id: string;
  prompt: string;
  context?: string;
  config: {
    cliAgents?: CliType[];
    agentCount?: number;
    synthesisStrategy?: string;
    personalities?: string[];
    confidenceThreshold?: number;
    timeout?: number;
    maxDebateRounds?: number;
    fallbackToApi?: boolean;
    mixedMode?: boolean;
  };
}

interface CliVerificationCancelPayload {
  id: string;
}

// ============================================
// Handler Registration
// ============================================

export function registerCliVerificationHandlers(mainWindow: BrowserWindow): void {
  const cliDetection = CliDetectionService.getInstance();
  const coordinator = getCliVerificationCoordinator();

  // ============================================
  // CLI Detection Handlers
  // ============================================

  // Detect all CLIs
  ipcMain.handle(
    'cli:detect-all',
    async (
      _event: IpcMainInvokeEvent,
      payload: CliDetectAllPayload
    ): Promise<IpcResponse> => {
      try {
        const result = await cliDetection.detectAll(payload?.force);
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
      payload: CliDetectOnePayload
    ): Promise<IpcResponse> => {
      try {
        const cliInfo = await cliDetection.detectOne(payload.command as CliType);
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
      payload: CliTestConnectionPayload
    ): Promise<IpcResponse> => {
      try {
        const cliInfo = await cliDetection.detectOne(payload.command as CliType);
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

  // ============================================
  // CLI Verification Handlers
  // ============================================

  // Set up event forwarding from coordinator to renderer
  setupCoordinatorEvents(coordinator, mainWindow);

  // Start CLI verification
  ipcMain.handle(
    'verification:start-cli',
    async (
      _event: IpcMainInvokeEvent,
      payload: CliVerificationStartPayload
    ): Promise<IpcResponse> => {
      try {
        const config: CliVerificationConfig = {
          agentCount: payload.config.agentCount || 3,
          cliAgents: payload.config.cliAgents,
          synthesisStrategy: (payload.config.synthesisStrategy as SynthesisStrategy) || 'debate',
          personalities: payload.config.personalities as PersonalityType[],
          confidenceThreshold: payload.config.confidenceThreshold || 0.7,
          timeout: payload.config.timeout || 300000,
          maxDebateRounds: payload.config.maxDebateRounds || 4,
          preferCli: true,
          fallbackToApi: payload.config.fallbackToApi ?? true,
          mixedMode: payload.config.mixedMode ?? false,
        };

        // Start verification (async - result sent via events)
        // Pass the frontend's session ID so events use the same ID
        coordinator.startVerificationWithCli(
          { prompt: payload.prompt, context: payload.context, id: payload.id },
          config
        ).then((result) => {
          mainWindow.webContents.send('verification:complete', {
            sessionId: payload.id,
            result,
          });
        }).catch((error) => {
          mainWindow.webContents.send('verification:error', {
            sessionId: payload.id,
            error: (error as Error).message,
          });
        });

        return { success: true, data: { verificationId: payload.id } };
      } catch (error) {
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
      payload: CliVerificationCancelPayload
    ): Promise<IpcResponse> => {
      try {
        const result = await coordinator.cancelVerification(payload.id);

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
            verificationId: payload.id,
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

function setupCoordinatorEvents(
  coordinator: ReturnType<typeof getCliVerificationCoordinator>,
  mainWindow: BrowserWindow
): void {
  console.log('[CLI-Verification-IPC] Setting up coordinator event forwarding');

  // Forward verification events to renderer
  coordinator.on('verification:started', (data) => {
    console.log('[CLI-Verification-IPC] Forwarding verification:started', data);
    mainWindow.webContents.send('verification:started', data);
  });

  coordinator.on('verification:agents-launching', (data) => {
    console.log('[CLI-Verification-IPC] Forwarding verification:agents-launching', data);
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
      console.log('[CLI-Verification-IPC] Sending verification:agent-start', payload);
      mainWindow.webContents.send('verification:agent-start', payload);
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
    console.log('[CLI-Verification-IPC] Sending verification:agent-stream (agentId:', data.agentId, ', chunk length:', (data.content || '').length, ')');
    mainWindow.webContents.send('verification:agent-stream', payload);
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
    console.log('[CLI-Verification-IPC] Sending verification:agent-complete', { agentId: data.agentId, success: data.success, responseLength: finalContent.length });
    mainWindow.webContents.send('verification:agent-complete', payload);
    // Clean up tracked content
    agentContent.delete(data.agentId);
  });

  coordinator.on('verification:completed', (result) => {
    console.log('[CLI-Verification-IPC] Sending verification:complete', { sessionId: result.id, hasResult: !!result });
    mainWindow.webContents.send('verification:complete', {
      sessionId: result.id,
      result,
    });
  });

  coordinator.on('verification:error', (data) => {
    console.log('[CLI-Verification-IPC] Sending verification:error', { sessionId: data.requestId, error: data.error?.message });
    mainWindow.webContents.send('verification:error', {
      sessionId: data.requestId,
      error: data.error?.message || 'Unknown error',
    });
  });

  // Forward cancellation events
  coordinator.on('verification:cancelled', (data) => {
    mainWindow.webContents.send('verification:cancelled', {
      sessionId: data.verificationId,
      reason: data.reason,
      agentsCancelled: data.agentsCancelled,
    });
  });

  coordinator.on('verification:agent-cancelled', (data) => {
    mainWindow.webContents.send('verification:agent-cancelled', {
      sessionId: data.verificationId,
      agentId: data.agentId,
    });
  });

  coordinator.on('warning', (data) => {
    mainWindow.webContents.send('verification:warning', data);
  });
}
