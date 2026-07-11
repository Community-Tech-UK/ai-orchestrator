import { resolveCliType } from '../cli/adapters/adapter-factory';
import type { CliMessage, CliResponse } from '../cli/adapters/base-cli-adapter';
import { getProviderRuntimeService } from '../providers/provider-runtime-service';
import { getSettingsManager } from '../core/config/settings-manager';
import type { CliType as SettingsCliType } from '../../shared/types/settings.types';

/**
 * Resolve the model a given reviewer CLI should run with for cross-model review.
 *
 * Returns a concrete model id only when the user has configured an explicit
 * override for that reviewer in `crossModelReviewModelByProvider`. A missing
 * entry, an empty string, or 'auto' yields `undefined`, meaning "pass no model"
 * so the reviewer CLI uses its own default/auto routing. We deliberately do NOT
 * fall back to a primary model — that would silently pin providers (e.g.
 * Copilot's primary is Gemini), defeating each CLI's native routing.
 *
 * Shared by the in-session review path (CrossModelReviewService.executeOneReview)
 * and the headless review path (ProviderReviewExecutionHost) so both honour the
 * same setting.
 */
export function resolveReviewerModelOverride(provider: string): string | undefined {
  const overrides = getSettingsManager().getAll().crossModelReviewModelByProvider ?? {};
  const configured = (overrides[provider] ?? '').trim();
  if (!configured || configured.toLowerCase() === 'auto') {
    return undefined;
  }
  return configured;
}

export interface ReviewExecutionHost {
  getWorkingDirectory(instanceId: string): string | undefined;
  getTaskDescription(instanceId: string): string | undefined;
  dispatchReviewerPrompt(provider: string, prompt: string, cwd: string, signal: AbortSignal): Promise<string>;
}

export interface HeadlessReviewRequest {
  target: string;
  cwd: string;
  content: string;
  taskDescription: string;
  reviewers?: string[];
  primaryProvider?: string;
  reviewDepth?: 'structured' | 'tiered';
  timeoutSeconds?: number;
  /** Optional caller cancellation bridged into remote and local review work. */
  signal?: AbortSignal;
}

function isCliAdapterLike(adapter: unknown): adapter is { sendMessage: (m: CliMessage) => Promise<CliResponse> } {
  return typeof (adapter as Record<string, unknown>)?.['sendMessage'] === 'function';
}

function isTerminableAdapter(adapter: unknown): adapter is { terminate: (graceful?: boolean) => Promise<void> } {
  return typeof (adapter as Record<string, unknown>)?.['terminate'] === 'function';
}

export class ProviderReviewExecutionHost implements ReviewExecutionHost {
  getWorkingDirectory(): string | undefined {
    return undefined;
  }

  getTaskDescription(): string | undefined {
    return undefined;
  }

  async dispatchReviewerPrompt(
    provider: string,
    prompt: string,
    cwd: string,
    signal: AbortSignal,
  ): Promise<string> {
    if (signal.aborted) {
      throw new Error('Review cancelled');
    }

    const resolvedCli = await resolveCliType(provider as SettingsCliType);
    const reviewerModel = resolveReviewerModelOverride(provider);
    const adapter = getProviderRuntimeService().createAdapter({
      cliType: resolvedCli,
      options: {
        workingDirectory: cwd,
        yoloMode: false,
        // When no override is configured, leave `model` unset so the reviewer
        // CLI uses its own default/auto routing.
        ...(reviewerModel ? { model: reviewerModel } : {}),
      },
    });

    try {
      if (!isCliAdapterLike(adapter)) {
        throw new Error(`CLI adapter "${provider}" does not support sendMessage`);
      }
      if (signal.aborted) {
        throw new Error('Review cancelled');
      }
      const response = await adapter.sendMessage({ role: 'user', content: prompt });
      return response.content;
    } finally {
      if (isTerminableAdapter(adapter)) {
        await adapter.terminate(false);
      }
    }
  }
}
