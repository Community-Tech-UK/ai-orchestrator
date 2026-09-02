import { resolveCliType } from '../cli/adapters/adapter-factory';
import type { CliMessage, CliResponse } from '../cli/adapters/base-cli-adapter';
import type { ReviewResult } from '../../shared/types/cross-model-review.types';
import { getProviderRuntimeService } from '../providers/provider-runtime-service';
import { attachCopilotRoute } from '../instance/lifecycle/copilot-route-preflight';
import type { CliType as SettingsCliType } from '../../shared/types/settings.types';
import { getProviderQuotaService } from '../core/system/provider-quota-service';
import { resolveAntigravityReviewModelPlan } from '../orchestration/antigravity-review-model-routing';
import { resolveReviewerModelOverride } from './reviewer-model-override';

/**
 * Lives in its own leaf module so this file and the checker planner can both use
 * it without an import cycle. Re-exported here because several call sites import
 * it from this module.
 */
export { resolveReviewerModelOverride };

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

/**
 * WS-B9: optional per-angle reviewer-verdict cache hook. Only the loop's
 * fresh-eyes gate supplies this (bound to its `LoopState` via
 * `review-coverage.ts`) — the standalone `aio review` CLI command leaves it
 * undefined, so `headless-review-runner.ts` always dispatches live for that
 * caller and behaves exactly as before WS-B9. `lookup`/`store` receive the
 * raw key components (not a precomputed key) so the runner never needs to
 * know how a key is built; the hook owner (the gate) computes it via
 * `buildAngleCacheKey`.
 */
export interface HeadlessReviewAngleCacheHook {
  lookup(input: {
    reviewerProvider: string;
    model: string;
    angleId: string;
    promptVersion: string;
    rulesHash: string;
    workHash: string;
  }): { review: ReviewResult; activationReason: string } | undefined;
  store(input: {
    reviewerProvider: string;
    model: string;
    angleId: string;
    promptVersion: string;
    rulesHash: string;
    workHash: string;
    review: ReviewResult;
  }): void;
}

export interface HeadlessReviewRequest {
  target: string;
  cwd: string;
  content: string;
  taskDescription: string;
  reviewers?: string[];
  /**
   * Provider that produced the work under review. Absent means genuinely
   * unknown, and constrains nothing — it must NOT be defaulted to a provider,
   * which would silently bar that provider from checking.
   */
  primaryProvider?: string;
  /**
   * Model that produced the work under review. Drives family diversity: the
   * checker runs a different vendor's model. Absent = unknown = no constraint.
   */
  primaryModel?: string;
  reviewDepth?: 'structured' | 'tiered';
  timeoutSeconds?: number;
  /** Optional caller cancellation bridged into remote and local review work. */
  signal?: AbortSignal;
  /** WS-B9: per-angle reviewer-verdict cache — see {@link HeadlessReviewAngleCacheHook}. */
  reviewCache?: HeadlessReviewAngleCacheHook;
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
    // Copilot account routing: reviews are an automatic surface.
    const reviewerSpawnOptions = await attachCopilotRoute(
      resolvedCli,
      {
        workingDirectory: cwd,
        yoloMode: false,
        // When no override is configured, leave `model` unset so the reviewer
        // CLI uses its own default/auto routing.
        ...(reviewerModel ? { model: reviewerModel } : {}),
        // WS14: Claude one-shots take the verdict schema natively; other CLIs
        // keep prompt-steered JSON (their flags differ; parser stays strict).
        ...(resolvedCli === 'claude' && options?.jsonSchema ? { jsonSchema: options.jsonSchema } : {}),
      },
      'review',
    );
    const adapter = getProviderRuntimeService().createAdapter({
      cliType: resolvedCli,
      options: reviewerSpawnOptions,
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
