/**
 * IPC handlers for the Auxiliary LLM feature.
 *
 * Exposes discovery, probing, test-generation, and settings-save operations
 * to the renderer. Delegates to AuxiliaryLlmService for all business logic.
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import { getAuxiliaryLlmService } from '../../rlm/auxiliary-llm-service';
import { getSettingsManager } from '../../core/config/settings-manager';
import { getLogger } from '../../logging/logger';
import type { IpcResponse } from '../validated-handler';
import type { AuxiliaryLlmSlot } from '../../../shared/types/auxiliary-llm.types';

const logger = getLogger('AuxiliaryLlmHandlers');

/** True if value looks like a raw API key (starts with sk-, ghp_, xoxb-, or is a long base64 blob). */
function looksLikeRawApiKey(value: string): boolean {
  return (
    /^sk-[A-Za-z0-9_-]{10,}/.test(value) ||
    /^ghp_[A-Za-z0-9]{10,}/.test(value) ||
    /^xoxb-[A-Za-z0-9-]{10,}/.test(value) ||
    /^[A-Za-z0-9+/]{40,}={0,2}$/.test(value)
  );
}

/** True if baseUrl is private/LAN/localhost (safe for Ollama). */
function isPrivateOrLocalhostUrl(baseUrl: string): boolean {
  try {
    const { hostname } = new URL(baseUrl);
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      /^192\.168\./.test(hostname) ||
      /^10\./.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
      /^100\./.test(hostname)
    );
  } catch {
    return false;
  }
}

export function registerAuxiliaryLlmHandlers(): void {
  // List candidates: localhost probe + configured endpoints
  ipcMain.handle(IPC_CHANNELS.AUXILIARY_LLM_LIST_CANDIDATES, async (): Promise<IpcResponse> => {
    try {
      const candidates = await getAuxiliaryLlmService().discoverCandidates();
      return { success: true, data: candidates };
    } catch (error) {
      logger.error('auxiliary-llm:list-candidates failed', error instanceof Error ? error : undefined);
      return {
        success: false,
        error: {
          code: 'AUXILIARY_LLM_LIST_FAILED',
          message: (error as Error).message,
          timestamp: Date.now(),
        },
      };
    }
  });

  // Probe an endpoint manually
  ipcMain.handle(IPC_CHANNELS.AUXILIARY_LLM_PROBE_ENDPOINT, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const { provider, baseUrl, apiKeyEnv } = payload as {
        provider: string;
        baseUrl: string;
        apiKeyEnv?: string;
      };

      if (provider === 'ollama' && !isPrivateOrLocalhostUrl(baseUrl)) {
        return {
          success: false,
          error: {
            code: 'ENDPOINT_NOT_ALLOWED',
            message: 'Ollama endpoints must be on localhost or private/Tailscale LAN',
            timestamp: Date.now(),
          },
        };
      }

      if (apiKeyEnv && looksLikeRawApiKey(apiKeyEnv)) {
        return {
          success: false,
          error: {
            code: 'RAW_API_KEY_REJECTED',
            message: 'apiKeyEnv must be an environment variable name, not a raw API key value',
            timestamp: Date.now(),
          },
        };
      }

      const { probeOllamaEndpoint, probeOpenAiCompatibleEndpoint } = await import('../../rlm/auxiliary-model-client');
      let healthy = false;
      if (provider === 'ollama') {
        healthy = await probeOllamaEndpoint(baseUrl, 5000);
      } else {
        const resolvedKey = apiKeyEnv ? process.env[apiKeyEnv] : undefined;
        healthy = await probeOpenAiCompatibleEndpoint(baseUrl, resolvedKey, 5000);
      }

      return { success: true, data: { healthy } };
    } catch (error) {
      logger.error('auxiliary-llm:probe-endpoint failed', error instanceof Error ? error : undefined);
      return {
        success: false,
        error: {
          code: 'PROBE_FAILED',
          message: (error as Error).message,
          timestamp: Date.now(),
        },
      };
    }
  });

  // Test generate for a slot
  ipcMain.handle(IPC_CHANNELS.AUXILIARY_LLM_TEST_GENERATE, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const { slot, systemPrompt, userPrompt } = payload as {
        slot: string;
        systemPrompt?: string;
        userPrompt?: string;
      };
      const { text, decision } = await getAuxiliaryLlmService().generate(
        slot as AuxiliaryLlmSlot,
        systemPrompt ?? 'You are a helpful assistant.',
        userPrompt ?? 'Say hello in one sentence.',
      );
      return { success: true, data: { text, decision } };
    } catch (error) {
      logger.error('auxiliary-llm:test-generate failed', error instanceof Error ? error : undefined);
      return {
        success: false,
        error: {
          code: 'TEST_GENERATE_FAILED',
          message: (error as Error).message,
          timestamp: Date.now(),
        },
      };
    }
  });

  // Save auxiliary LLM settings
  ipcMain.handle(IPC_CHANNELS.AUXILIARY_LLM_SAVE_SETTINGS, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const settings = payload as {
        auxiliaryLlmEnabled?: boolean;
        auxiliaryLlmRoutingMode?: string;
        auxiliaryLlmAllowRemoteWorkerModels?: boolean;
        auxiliaryLlmEndpointsJson?: string;
        auxiliaryLlmSlotsJson?: string;
      };

      const manager = getSettingsManager();
      const allowedKeys = [
        'auxiliaryLlmEnabled',
        'auxiliaryLlmRoutingMode',
        'auxiliaryLlmAllowRemoteWorkerModels',
        'auxiliaryLlmEndpointsJson',
        'auxiliaryLlmSlotsJson',
      ] as const;

      for (const key of allowedKeys) {
        if (key in settings && settings[key] !== undefined) {
          manager.set(key, settings[key] as never);
        }
      }

      // Reconfigure service with updated settings
      const current = manager.getAll();
      getAuxiliaryLlmService().configure({
        auxiliaryLlmEnabled: current.auxiliaryLlmEnabled,
        auxiliaryLlmRoutingMode: current.auxiliaryLlmRoutingMode,
        auxiliaryLlmAllowRemoteWorkerModels: current.auxiliaryLlmAllowRemoteWorkerModels,
        auxiliaryLlmEndpointsJson: current.auxiliaryLlmEndpointsJson,
        auxiliaryLlmSlotsJson: current.auxiliaryLlmSlotsJson,
      });

      return { success: true, data: { ok: true } };
    } catch (error) {
      logger.error('auxiliary-llm:save-settings failed', error instanceof Error ? error : undefined);
      return {
        success: false,
        error: {
          code: 'SAVE_SETTINGS_FAILED',
          message: (error as Error).message,
          timestamp: Date.now(),
        },
      };
    }
  });
}
