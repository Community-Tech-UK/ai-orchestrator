import { resolveCliType } from '../cli/adapters/adapter-factory';
import type { CliMessage, CliResponse } from '../cli/adapters/base-cli-adapter';
import { getProviderRuntimeService } from '../providers/provider-runtime-service';
import { getSettingsManager } from '../core/config/settings-manager';
import type { CliType as SettingsCliType } from '../../shared/types/settings.types';
import { getProviderQuotaService } from '../core/system/provider-quota-service';
import { resolveAntigravityReviewModelPlan } from '../orchestration/antigravity-review-model-routing';

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
  dispatchReviewerPrompt(
    provider: string,
    prompt: string,
    cwd: string,
    signal: AbortSignal,
    options?: { modelOverride?: string; jsonSchema?: string },
  ): Promise<string>;
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

function isInterruptibleAdapter(adapter: unknown): adapter is { interrupt: () => unknown } {
  return typeof (adapter as Record<string, unknown>)?.['interrupt'] === 'function';
}

function cancelAdapter(adapter: unknown): void {
  if (isInterruptibleAdapter(adapter)) {
    try {
      adapter.interrupt();
    } catch {
      // Force termination below remains the authoritative cancellation path.
    }
  }
  if (isTerminableAdapter(adapter)) {
    try {
      void Promise.resolve(adapter.terminate(false)).catch(() => undefined);
    } catch {
      // Cancellation must settle even if a non-conforming adapter throws here.
    }
  }
}

export async function sendAbortableReviewerMessage(
  adapter: { sendMessage: (message: CliMessage) => Promise<CliResponse> },
  message: CliMessage,
  signal: AbortSignal,
  onAbort?: () => void,
): Promise<CliResponse> {
  if (signal.aborted) throw new Error('Review cancelled');
  let removeAbortListener: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    const handleAbort = () => {
      onAbort?.();
      cancelAdapter(adapter);
      reject(new Error('Review cancelled'));
    };
    signal.addEventListener('abort', handleAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener('abort', handleAbort);
  });
  try {
    return await Promise.race([adapter.sendMessage(message), cancelled]);
  } finally {
    removeAbortListener?.();
  }
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
    options?: { modelOverride?: string; jsonSchema?: string },
  ): Promise<string> {
    if (signal.aborted) {
      throw new Error('Review cancelled');
    }

    const resolvedCli = await resolveCliType(provider as SettingsCliType);
    const configuredModel = resolveReviewerModelOverride(provider);
    const reviewerModel = options && Object.hasOwn(options, 'modelOverride')
      ? options.modelOverride
      : provider === 'antigravity'
        ? resolveAntigravityReviewModelPlan(
            configuredModel,
            getProviderQuotaService().getSnapshot('antigravity'),
          )[0]
        : configuredModel;
    const adapter = getProviderRuntimeService().createAdapter({
      cliType: resolvedCli,
      options: {
        workingDirectory: cwd,
        yoloMode: false,
        // When no override is configured, leave `model` unset so the reviewer
        // CLI uses its own default/auto routing.
        ...(reviewerModel ? { model: reviewerModel } : {}),
        // WS14: Claude one-shots take the verdict schema natively; other CLIs
        // keep prompt-steered JSON (their flags differ; parser stays strict).
        ...(resolvedCli === 'claude' && options?.jsonSchema ? { jsonSchema: options.jsonSchema } : {}),
      },
    });

    let cancelled = false;
    try {
      if (!isCliAdapterLike(adapter)) {
        throw new Error(`CLI adapter "${provider}" does not support sendMessage`);
      }
      if (signal.aborted) {
        throw new Error('Review cancelled');
      }
      const response = await sendAbortableReviewerMessage(
        adapter,
        { role: 'user', content: prompt },
        signal,
        () => { cancelled = true; },
      );
      return response.content;
    } finally {
      if (!cancelled && isTerminableAdapter(adapter)) {
        await adapter.terminate(false);
      }
    }
  }
}
