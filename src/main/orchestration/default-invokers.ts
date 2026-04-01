/**
 * Default Orchestration Invokers
 *
 * Wires "extensibility points" (event-based invocation) to real CLI execution.
 * This replaces placeholder/stub behavior in MultiVerifyCoordinator by using our
 * in-repo CLI adapters directly (no dependency on sibling repos at runtime).
 */

import type { InstanceManager } from '../instance/instance-manager';
import { getLogger } from '../logging/logger';
import { getMultiVerifyCoordinator } from './multi-verify-coordinator';
import { getReviewCoordinator } from '../agents/review-coordinator';
import { getDebateCoordinator } from './debate-coordinator';
import { getWorkflowManager } from '../workflows/workflow-manager';
import { createCliAdapter, resolveCliType, type CliAdapter, type UnifiedSpawnOptions } from '../cli/adapters/adapter-factory';
import type { CliMessage, CliResponse } from '../cli/adapters/base-cli-adapter';
import { getSettingsManager } from '../core/config/settings-manager';
import { getCircuitBreakerRegistry } from '../core/circuit-breaker';
import { coerceToFailoverError } from '../core/failover-error';
import { DEFAULT_MODELS, type ProviderType } from '../../shared/types/provider.types';
import type { CliType } from '../cli/cli-detection';

const logger = getLogger('DefaultInvokers');

/**
 * Maps CLI type to ProviderType key used in DEFAULT_MODELS.
 * When an invoker has no explicit model (payload model is 'default' or absent),
 * this lets us pass the correct default for the resolved CLI rather than
 * letting the CLI binary pick its own (potentially outdated) default.
 */
const CLI_TO_PROVIDER: Record<CliType, ProviderType> = {
  claude: 'claude-cli',
  codex: 'openai',
  gemini: 'google',
  copilot: 'claude-cli', // Copilot routes through multiple providers; leave model to caller
  ollama: 'ollama',
};

function resolveDefaultModel(cliType: CliType, payloadModel?: string): string | undefined {
  if (typeof payloadModel === 'string' && payloadModel !== 'default') return payloadModel;
  const providerType = CLI_TO_PROVIDER[cliType];
  return providerType ? DEFAULT_MODELS[providerType] : undefined;
}

function isBaseCliAdapterLike(adapter: CliAdapter): adapter is CliAdapter & { sendMessage: (m: CliMessage) => Promise<CliResponse> } {
  return typeof (adapter as any).sendMessage === 'function';
}

function buildUserPrompt(userPrompt: string, context?: string): string {
  if (!context || !context.trim()) return userPrompt;
  return `${context.trim()}\n\n---\n\n${userPrompt}`;
}

export function registerDefaultMultiVerifyInvoker(instanceManager: InstanceManager): void {
  const coordinator = getMultiVerifyCoordinator();
  const settings = getSettingsManager();

  // Avoid double-registration if initialize() is called multiple times (macOS window lifecycle).
  const alreadyRegistered = coordinator.listenerCount('verification:invoke-agent') > 0;
  if (alreadyRegistered) return;

  coordinator.on('verification:invoke-agent', async (payload: any) => {
    const callback = payload?.callback as ((err: string | null, response?: string, tokens?: number, cost?: number) => void) | undefined;
    if (!callback) return;

    try {
      const instanceId = payload.instanceId as string | undefined;
      const instance = instanceId ? instanceManager.getInstance(instanceId) : undefined;

      const workingDirectory = instance?.workingDirectory || process.cwd();
      const requestedProvider = (instance?.provider as any) || 'auto';
      const defaultCli = settings.getAll().defaultCli;

      const cliType = await resolveCliType(requestedProvider, defaultCli);

      const model = resolveDefaultModel(cliType, payload.model);
      const systemPrompt = typeof payload.systemPrompt === 'string' ? payload.systemPrompt : undefined;

      const spawnOptions: UnifiedSpawnOptions = {
        workingDirectory,
        model,
        systemPrompt,
        yoloMode: false,
        timeout: 300000,
      };

      // Use circuit breaker to prevent cascading failures
      const breaker = getCircuitBreakerRegistry().getBreaker(`verify-${cliType}`, {
        failureThreshold: 3,
        resetTimeoutMs: 60000,
      });

      const response = await breaker.execute(async () => {
        const adapter = createCliAdapter(cliType, spawnOptions);
        if (!isBaseCliAdapterLike(adapter)) {
          throw new Error(`CLI adapter "${cliType}" does not support one-shot sendMessage`);
        }

        const prompt = buildUserPrompt(String(payload.userPrompt || ''), payload.context ? String(payload.context) : undefined);
        return adapter.sendMessage({ role: 'user', content: prompt });
      });

      const tokens = response.usage?.totalTokens ?? 0;
      const cost = 0;
      callback(null, response.content, tokens, cost);
    } catch (err) {
      // Classify the error for better diagnostics
      const failoverErr = coerceToFailoverError(err);
      if (failoverErr) {
        logger.warn('Verification agent invocation failed (classified)', {
          reason: failoverErr.reason,
          retryable: failoverErr.retryable,
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      callback(message);
    }
  });
}

export function registerDefaultReviewInvoker(instanceManager: InstanceManager): void {
  const coordinator = getReviewCoordinator();
  const settings = getSettingsManager();

  const alreadyRegistered = coordinator.listenerCount('review:invoke-agent') > 0;
  if (alreadyRegistered) return;

  coordinator.on('review:invoke-agent', async (payload: any) => {
    const callback = payload?.callback as ((err: string | null, response?: string, tokens?: number, cost?: number) => void) | undefined;
    if (!callback) return;

    try {
      const instanceId = payload.instanceId as string | undefined;
      const instance = instanceId ? instanceManager.getInstance(instanceId) : undefined;

      const workingDirectory = instance?.workingDirectory || process.cwd();
      const requestedProvider = (instance?.provider as any) || 'auto';
      const defaultCli = settings.getAll().defaultCli;
      const cliType = await resolveCliType(requestedProvider, defaultCli);

      const model = resolveDefaultModel(cliType, payload.model);
      const systemPrompt = typeof payload.systemPrompt === 'string' ? payload.systemPrompt : undefined;

      const spawnOptions: UnifiedSpawnOptions = {
        workingDirectory,
        model,
        systemPrompt,
        yoloMode: false,
        timeout: 300000,
      };

      // Use circuit breaker to prevent cascading failures
      const breaker = getCircuitBreakerRegistry().getBreaker(`review-${cliType}`, {
        failureThreshold: 3,
        resetTimeoutMs: 60000,
      });

      const response = await breaker.execute(async () => {
        const adapter = createCliAdapter(cliType, spawnOptions);
        if (!isBaseCliAdapterLike(adapter)) {
          throw new Error(`CLI adapter "${cliType}" does not support one-shot sendMessage`);
        }

        const prompt = buildUserPrompt(String(payload.userPrompt || ''), payload.context ? String(payload.context) : undefined);
        return adapter.sendMessage({ role: 'user', content: prompt });
      });

      const tokens = response.usage?.totalTokens ?? 0;
      const cost = 0;
      callback(null, response.content, tokens, cost);
    } catch (err) {
      const failoverErr = coerceToFailoverError(err);
      if (failoverErr) {
        logger.warn('Review agent invocation failed (classified)', {
          reason: failoverErr.reason,
          retryable: failoverErr.retryable,
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      callback(message);
    }
  });
}

const DEBATE_EVENTS = [
  'debate:generate-response',
  'debate:generate-critiques',
  'debate:generate-defense',
  'debate:generate-synthesis',
] as const;

export function registerDefaultDebateInvoker(instanceManager: InstanceManager): void {
  const coordinator = getDebateCoordinator();
  const settings = getSettingsManager();

  for (const eventName of DEBATE_EVENTS) {
    const alreadyRegistered = coordinator.listenerCount(eventName) > 0;
    if (alreadyRegistered) continue;

    coordinator.on(eventName, async (payload: any) => {
      const callback = payload?.callback as ((...args: any[]) => void) | undefined;
      if (!callback) return;

      let adapter: CliAdapter | undefined;
      try {
        const instanceId = payload.instanceId as string | undefined;
        const instance = instanceId ? instanceManager.getInstance(instanceId) : undefined;

        const workingDirectory = instance?.workingDirectory || process.cwd();
        const requestedProvider = (payload.provider as string | undefined) || (instance?.provider as any) || 'auto';
        const defaultCli = settings.getAll().defaultCli;
        const cliType = await resolveCliType(requestedProvider as any, defaultCli);

        const model = resolveDefaultModel(cliType, payload.model);
        const systemPrompt = typeof payload.systemPrompt === 'string' ? payload.systemPrompt : undefined;

        const spawnOptions: UnifiedSpawnOptions = {
          workingDirectory,
          model,
          systemPrompt,
          yoloMode: false,
          timeout: 300000,
        };

        // Use circuit breaker to prevent cascading failures
        const breaker = getCircuitBreakerRegistry().getBreaker(`debate-${cliType}`, {
          failureThreshold: 3,
          resetTimeoutMs: 60000,
        });

        const response = await breaker.execute(async () => {
          adapter = createCliAdapter(cliType, spawnOptions);
          if (!isBaseCliAdapterLike(adapter)) {
            throw new Error(`CLI adapter "${cliType}" does not support one-shot sendMessage`);
          }

          const prompt = buildUserPrompt(String(payload.prompt || ''), payload.context ? String(payload.context) : undefined);
          return adapter.sendMessage({ role: 'user', content: prompt });
        });

        const tokens = response.usage?.totalTokens ?? 0;
        // generate-response callback expects (response, tokens); others expect (response)
        if (eventName === 'debate:generate-response') {
          callback(response.content, tokens);
        } else {
          callback(response.content);
        }
      } catch (err) {
        // Classify the error for better diagnostics
        const failoverErr = coerceToFailoverError(err);
        if (failoverErr) {
          logger.warn('Debate agent invocation failed (classified)', {
            reason: failoverErr.reason,
            retryable: failoverErr.retryable,
            eventName,
          });
        }
        // Debate callbacks don't have an error parameter — the Promise will
        // time out on the coordinator side if no callback is invoked.
        logger.error('Error handling debate event', err instanceof Error ? err : undefined, { eventName });
      } finally {
        if (adapter && typeof (adapter as any).terminate === 'function') {
          try { (adapter as any).terminate(); } catch { /* cleanup */ }
        }
      }
    });
  }
}

export function registerDefaultWorkflowInvoker(instanceManager: InstanceManager): void {
  const manager = getWorkflowManager();
  const settings = getSettingsManager();

  const alreadyRegistered = manager.listenerCount('workflow:invoke-agent') > 0;
  if (alreadyRegistered) return;

  manager.on('workflow:invoke-agent', async (payload: any) => {
    const callback = payload?.callback as ((response: string, tokens: number) => void) | undefined;
    if (!callback) return;

    let adapter: CliAdapter | undefined;
    try {
      // Find the instance associated with this workflow execution by scanning instanceExecutions
      const executionId = payload.executionId as string | undefined;
      let instance: ReturnType<InstanceManager['getInstance']> | undefined;
      if (executionId) {
        for (const inst of instanceManager.getAllInstances()) {
          const execution = manager.getExecutionByInstance(inst.id);
          if (execution?.id === executionId) {
            instance = inst;
            break;
          }
        }
      }

      const workingDirectory = instance?.workingDirectory || process.cwd();
      const requestedProvider = (instance?.provider as any) || 'auto';
      const defaultCli = settings.getAll().defaultCli;
      const cliType = await resolveCliType(requestedProvider, defaultCli);

      const model = resolveDefaultModel(cliType, payload.model);
      const agentType = typeof payload.agentType === 'string' ? payload.agentType : undefined;
      const systemPrompt = agentType
        ? `You are a ${agentType} agent. Complete the task described below thoroughly and accurately.`
        : undefined;

      const spawnOptions: UnifiedSpawnOptions = {
        workingDirectory,
        model,
        systemPrompt,
        yoloMode: false,
        timeout: 300000,
      };

      const breaker = getCircuitBreakerRegistry().getBreaker(`workflow-${cliType}`, {
        failureThreshold: 3,
        resetTimeoutMs: 60000,
      });

      const response = await breaker.execute(async () => {
        adapter = createCliAdapter(cliType, spawnOptions);
        if (!isBaseCliAdapterLike(adapter)) {
          throw new Error(`CLI adapter "${cliType}" does not support one-shot sendMessage`);
        }

        return adapter.sendMessage({ role: 'user', content: String(payload.prompt || '') });
      });

      const tokens = response.usage?.totalTokens ?? 0;
      callback(response.content, tokens);
    } catch (err) {
      const failoverErr = coerceToFailoverError(err);
      if (failoverErr) {
        logger.warn('Workflow agent invocation failed (classified)', {
          reason: failoverErr.reason,
          retryable: failoverErr.retryable,
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Error handling workflow:invoke-agent', err instanceof Error ? err : undefined);
      // Workflow callbacks expect (response, tokens) — return error as response
      callback(`[Error: ${message}]`, 0);
    } finally {
      if (adapter && typeof (adapter as any).terminate === 'function') {
        try { (adapter as any).terminate(); } catch { /* cleanup */ }
      }
    }
  });
}
