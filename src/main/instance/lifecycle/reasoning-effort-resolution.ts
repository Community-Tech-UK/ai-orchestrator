import {
  getDefaultReasoningEffort,
  type ReasoningEffort,
} from '../../../shared/types/provider.types';
import type { InstanceCreateConfig } from '../../../shared/types/instance.types';

/**
 * Resolve the reasoning effort a fresh spawn should run at.
 *
 * Only the model picker ever supplied an effort explicitly. Every other path
 * through `createInstance` — orchestration children, repo jobs, history restore,
 * ping-pong reviewers, and automations without a pinned effort — passed nothing,
 * and passing nothing means the CLI applies *its own* default. That is how fresh
 * Codex sessions ran at `medium` while the app advertised `high`.
 *
 * Headless one-shot adapters built directly via `createCliAdapter` (loop
 * invokers, consensus/multi-verify, auto-title, magic-prompt, compare) do NOT
 * go through here and stay provider-decided by design — they are short,
 * throwaway calls that should not be silently upgraded to `high`.
 *
 * The three input states are deliberately distinct:
 * - a concrete effort  -> use it verbatim
 * - `null`             -> the caller picked the picker's "let the provider
 *                         decide" row, so send no effort at all
 * - `undefined`        -> nobody chose, so apply the app-level default
 *
 * Cross-model reviewers are the one caller that intentionally pins a cheaper
 * effort (`cross-model-review-service.ts` uses `'low'` for Codex); that is an
 * explicit choice and survives here untouched.
 */
export function resolveSpawnReasoningEffort(
  source: Pick<InstanceCreateConfig, 'reasoningEffort' | 'modelRuntimeTarget'>,
  provider: string | null | undefined,
  model?: string | null,
): ReasoningEffort | undefined {
  // Local-model runtimes are served by adapters that never read
  // `reasoningEffort`. Defaulting one in would only mislead the picker, which
  // renders the instance's stored effort back to the user.
  if (source.modelRuntimeTarget?.kind === 'local-model') return undefined;
  if (source.reasoningEffort === null) return undefined;
  if (source.reasoningEffort !== undefined) return source.reasoningEffort;
  return getDefaultReasoningEffort(provider, model) ?? undefined;
}
