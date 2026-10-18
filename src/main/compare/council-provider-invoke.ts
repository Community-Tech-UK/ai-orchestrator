/**
 * Shared one-shot provider invocation for multi-provider compare (backlog
 * #11) and Ask Council synthesis (WS-B6). Both the parallel `compare()` fan-
 * out and the progressive Council run engine send the SAME prompt shape to a
 * single provider via `createAdapter` + `sendMessage` (the ephemeral one-shot
 * path magic-prompts and auto-title already use) — this module is the single
 * implementation both call, so cancellation and error handling stay in sync.
 */

import { resolveCliType, type CliAdapter, type UnifiedSpawnOptions } from '../cli/adapters/adapter-factory';
import type { CliMessage, CliResponse } from '../cli/adapters/base-cli-adapter';
import { isCliAvailable, type CliType } from '../cli/cli-detection';
import { isProviderNotice } from '../cli/provider-notice';
import { resolveModelForTier } from '../../shared/types/provider.types';
import { getProviderRuntimeService } from '../providers/provider-runtime-service';
import { observeModelCallUsage, isModelCallCancelled } from '../core/system/observed-model-call-usage';
import { recordModelCall } from '../core/system/model-call-recorder';
import { attachProviderRoutes } from '../instance/lifecycle/provider-route-preflight';

/** Wall-clock cap for a single provider's one-shot response. */
export const PROVIDER_INVOKE_TIMEOUT = 60_000;

export interface ProviderInvokeDeps {
  /** Resolve a SPECIFIC provider (no preference fallback). null if unavailable. */
  resolveProvider(provider: string): Promise<CliType | null>;
  createAdapter(cliType: CliType, options: UnifiedSpawnOptions): CliAdapter;
  /** Monotonic clock for durations. Injectable for deterministic tests. */
  now(): number;
}

export interface ProviderInvokeResult {
  ok: boolean;
  model?: string;
  answer?: string;
  error?: string;
  durationMs: number;
  usage?: CliResponse['usage'];
}

export async function defaultResolveProvider(provider: string): Promise<CliType | null> {
  try {
    const info = await isCliAvailable(provider as CliType);
    if (info.installed) return await resolveCliType(provider as CliType);
  } catch {
    // treat as unavailable
  }
  return null;
}

export const DEFAULT_PROVIDER_INVOKE_DEPS: ProviderInvokeDeps = {
  resolveProvider: defaultResolveProvider,
  createAdapter: (cliType, options) => getProviderRuntimeService().createAdapter({ cliType, options }),
  now: () => Date.now(),
};

type SendMessageAdapter = CliAdapter & {
  sendMessage: (message: CliMessage) => Promise<CliResponse>;
};

function hasSendMessage(adapter: CliAdapter): adapter is SendMessageAdapter {
  return typeof (adapter as { sendMessage?: unknown }).sendMessage === 'function';
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Send `prompt` to a single `provider` as an ephemeral one-shot and return
 * its answer (or a structured failure). Never throws — every failure mode
 * (unavailable provider, spawn error, empty/notice response, thrown error,
 * cancellation) becomes a `{ ok: false, error }` result so callers can fan
 * out N of these with `Promise.allSettled`-free code.
 */
export async function invokeProviderOneShot(
  deps: ProviderInvokeDeps,
  provider: string,
  prompt: string,
  options: {
    purpose?: 'council' | 'compare';
    correlationId?: string;
    workingDirectory?: string;
    signal?: AbortSignal;
    /** Reports the live adapter back to the caller so it can be terminated on cancellation. */
    onAdapterCreated?: (adapter: CliAdapter) => void;
  } = {},
): Promise<ProviderInvokeResult> {
  const started = deps.now();
  const elapsed = () => deps.now() - started;

  if (options.signal?.aborted) {
    return { ok: false, error: 'Cancelled', durationMs: elapsed() };
  }

  const cliType = await deps.resolveProvider(provider);
  if (!cliType) {
    return { ok: false, error: 'Provider is not available', durationMs: elapsed() };
  }
  if (options.signal?.aborted) {
    return { ok: false, error: 'Cancelled', durationMs: elapsed() };
  }

  const model = resolveModelForTier('balanced', cliType);
  let adapter: CliAdapter;
  try {
    // Copilot account routing: a council/compare fan-out picks providers on
    // the user's behalf.
    adapter = deps.createAdapter(
      cliType,
      await attachProviderRoutes(
        cliType,
        {
          workingDirectory: options.workingDirectory ?? process.cwd(),
          model,
          yoloMode: false,
          timeout: PROVIDER_INVOKE_TIMEOUT,
          maxBudgetUsd: cliType === 'claude' ? 1 : undefined,
        },
        'consensus',
      ),
    );
  } catch (error) {
    return { ok: false, model, error: errMsg(error), durationMs: elapsed() };
  }
  options.onAdapterCreated?.(adapter);

  if (!hasSendMessage(adapter)) {
    return { ok: false, model, error: 'Provider does not support one-shot prompts', durationMs: elapsed() };
  }

  if (options.signal?.aborted) return { ok: false, model, error: 'Cancelled', durationMs: elapsed() };
  const observed = observeModelCallUsage(adapter);
  let outcome: 'success' | 'error' | 'cancelled' | 'budget-exceeded' = 'error';
  try {
    const response = await adapter.sendMessage({ role: 'user', content: prompt });
    observed.observe(response.usage);
    const usage = observed.usage;
    if (response.metadata?.['budgetExceeded'] === true) {
      outcome = 'budget-exceeded';
      return { ok: false, model, usage, error: 'Provider budget exceeded', durationMs: elapsed() };
    }
    if (options.signal?.aborted) {
      outcome = 'cancelled';
      return { ok: false, model, error: 'Cancelled', durationMs: elapsed() };
    }
    const raw = (response.content ?? '').trim();
    if (raw.length === 0) {
      return { ok: false, model, error: 'Empty response', durationMs: elapsed() };
    }
    if (isProviderNotice(raw)) {
      return { ok: false, model, error: 'Provider returned a status/limit notice', durationMs: elapsed() };
    }
    outcome = 'success';
    return { ok: true, model, answer: raw, usage, durationMs: elapsed() };
  } catch (error) {
    observed.observeError(error);
    if (options.signal?.aborted || isModelCallCancelled(error)) {
      outcome = 'cancelled';
      return { ok: false, model, error: 'Cancelled', durationMs: elapsed() };
    }
    return { ok: false, model, error: errMsg(error), durationMs: elapsed() };
  } finally {
    observed.dispose();
    if (observed.dispatched) recordModelCall({ purpose: options.purpose ?? 'council', provider: cliType, model, usage: observed.usage, outcome, correlationId: options.correlationId });
  }
}
