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

/**
 * Slot-appropriate default prompts for the "Test prompt" button.
 *
 * A generic "say hello" prompt produces meaningless output for JSON slots
 * (Ollama in `format:json` mode emits something like `{"//":"..."}`). These
 * per-slot prompts exercise each slot the way it's actually used, and the
 * JSON slots explicitly request the JSON shape the slot expects.
 */
const SLOT_TEST_PROMPTS: Record<AuxiliaryLlmSlot, { system: string; user: string }> = {
  compression: {
    system: 'You compress conversation context into a concise reference summary.',
    user: 'Summarize: The user asked to add a login button; we edited auth.ts, wired the click handler, and ran the tests, which passed.',
  },
  memoryDistillation: {
    system: 'You distill durable, reusable facts from a conversation.',
    user: 'Distill the key facts: The user prefers TypeScript, runs tests with Vitest, and is working on macOS.',
  },
  webExtract: {
    system: 'You extract the main textual content from a web page, discarding navigation and boilerplate.',
    user: 'Extract the key points: <nav>Home About</nav><h1>Pricing</h1><p>The Pro plan is $20/month with unlimited projects.</p>',
  },
  titleGeneration: {
    system: 'You generate a short conversation title of 3-6 words. Reply with the title only.',
    user: 'Generate a title for a chat about diagnosing and fixing an Ollama auxiliary-model timeout.',
  },
  routingClassification: {
    system: 'You classify whether a request can be handled by a cheap local model. Respond ONLY with JSON: {"eligible":boolean,"reason":string}.',
    user: 'Is the request "summarize this paragraph" eligible for a cheap local model? Respond as JSON.',
  },
  approvalScoring: {
    system: 'You provide an advisory risk score for a shell command. Respond ONLY with JSON: {"score":number,"confidence":number,"reason":string}.',
    user: 'Score the risk of running "ls -la" on a scale of 0-1. Respond as JSON.',
  },
  loopScoring: {
    system: 'You provide an advisory quality score for an agent loop step. Respond ONLY with JSON: {"score":number,"confidence":number,"reason":string}.',
    user: 'Score this loop step on a scale of 0-1: "Ran the test suite, all green, task complete." Respond as JSON.',
  },
};

const GENERIC_TEST_PROMPT = {
  system: 'You are a helpful assistant.',
  user: 'Say hello in one sentence.',
};

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
      const defaults = SLOT_TEST_PROMPTS[slot as AuxiliaryLlmSlot] ?? GENERIC_TEST_PROMPT;
      const { text, decision } = await getAuxiliaryLlmService().generate(
        slot as AuxiliaryLlmSlot,
        systemPrompt ?? defaults.system,
        userPrompt ?? defaults.user,
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
