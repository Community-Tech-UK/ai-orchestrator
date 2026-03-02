/**
 * Default Orchestration Invokers
 *
 * Wires "extensibility points" (event-based invocation) to real CLI execution.
 * This replaces placeholder/stub behavior in MultiVerifyCoordinator by using our
 * in-repo CLI adapters directly (no dependency on sibling repos at runtime).
 */

import type { InstanceManager } from '../instance/instance-manager';
import { getMultiVerifyCoordinator } from './multi-verify-coordinator';
import { getReviewCoordinator } from '../agents/review-coordinator';
import { getDebateCoordinator } from './debate-coordinator';
import { createCliAdapter, resolveCliType, type CliAdapter, type UnifiedSpawnOptions } from '../cli/adapters/adapter-factory';
import type { CliMessage, CliResponse } from '../cli/adapters/base-cli-adapter';
import { getSettingsManager } from '../core/config/settings-manager';

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

      const model = typeof payload.model === 'string' && payload.model !== 'default' ? payload.model : undefined;
      const systemPrompt = typeof payload.systemPrompt === 'string' ? payload.systemPrompt : undefined;

      const spawnOptions: UnifiedSpawnOptions = {
        workingDirectory,
        model,
        systemPrompt,
        yoloMode: false,
        timeout: 300000,
      };

      const adapter = createCliAdapter(cliType, spawnOptions);
      if (!isBaseCliAdapterLike(adapter)) {
        throw new Error(`CLI adapter "${cliType}" does not support one-shot sendMessage`);
      }

      const prompt = buildUserPrompt(String(payload.userPrompt || ''), payload.context ? String(payload.context) : undefined);
      const response = await adapter.sendMessage({ role: 'user', content: prompt });

      const tokens = response.usage?.totalTokens ?? 0;
      const cost = 0;
      callback(null, response.content, tokens, cost);
    } catch (err) {
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

      const model = typeof payload.model === 'string' && payload.model !== 'default' ? payload.model : undefined;
      const systemPrompt = typeof payload.systemPrompt === 'string' ? payload.systemPrompt : undefined;

      const spawnOptions: UnifiedSpawnOptions = {
        workingDirectory,
        model,
        systemPrompt,
        yoloMode: false,
        timeout: 300000,
      };

      const adapter = createCliAdapter(cliType, spawnOptions);
      if (!isBaseCliAdapterLike(adapter)) {
        throw new Error(`CLI adapter "${cliType}" does not support one-shot sendMessage`);
      }

      const prompt = buildUserPrompt(String(payload.userPrompt || ''), payload.context ? String(payload.context) : undefined);
      const response = await adapter.sendMessage({ role: 'user', content: prompt });

      const tokens = response.usage?.totalTokens ?? 0;
      const cost = 0;
      callback(null, response.content, tokens, cost);
    } catch (err) {
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

export function registerDefaultDebateInvoker(_instanceManager: InstanceManager): void {
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
        const defaultCli = settings.getAll().defaultCli;
        const cliType = await resolveCliType('auto', defaultCli);

        const model = typeof payload.model === 'string' && payload.model !== 'default' ? payload.model : undefined;
        const systemPrompt = typeof payload.systemPrompt === 'string' ? payload.systemPrompt : undefined;

        const spawnOptions: UnifiedSpawnOptions = {
          workingDirectory: process.cwd(),
          model,
          systemPrompt,
          yoloMode: false,
          timeout: 300000,
        };

        adapter = createCliAdapter(cliType, spawnOptions);
        if (!isBaseCliAdapterLike(adapter)) {
          throw new Error(`CLI adapter "${cliType}" does not support one-shot sendMessage`);
        }

        const prompt = buildUserPrompt(String(payload.prompt || ''), payload.context ? String(payload.context) : undefined);
        const response = await adapter.sendMessage({ role: 'user', content: prompt });

        const tokens = response.usage?.totalTokens ?? 0;
        // generate-response callback expects (response, tokens); others expect (response)
        if (eventName === 'debate:generate-response') {
          callback(response.content, tokens);
        } else {
          callback(response.content);
        }
      } catch (err) {
        // Debate callbacks don't have an error parameter — the Promise will
        // time out on the coordinator side if no callback is invoked.
        console.error(`[DebateInvoker] Error handling ${eventName}:`, err);
      } finally {
        if (adapter && typeof (adapter as any).terminate === 'function') {
          try { (adapter as any).terminate(); } catch { /* cleanup */ }
        }
      }
    });
  }
}
