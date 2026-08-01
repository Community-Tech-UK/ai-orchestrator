/**
 * WS-C7 — fire-time gate for the `contained` automation execution profile.
 *
 * Pure and tiny on purpose: `AutomationRunner` calls this with the SAME
 * resolved provider it is about to spawn with (`resolveAutomationSpawnTarget`
 * — the exact function that also picks the provider/model for the real
 * `createInstance` call), so the gate can never diverge from what actually
 * spawns. Codex is the only provider with a real, technically-enforced
 * sandbox in this codebase (`sandboxMode: 'read-only'` /
 * `'danger-full-access'`, adapter-factory.ts `createCodexAdapter`) — every
 * other provider is instruction-only, so a `contained` run resolving to
 * anything but Codex fails the run rather than silently running less
 * contained than requested.
 */

import type { AutomationExecutionProfile } from '../../shared/types/automation.types';
import type { InstanceProvider } from '../../shared/types/instance.types';

export interface ContainedExecutionGateResult {
  ok: boolean;
  /** Present only when `ok` is false — the plain-language run-failure reason. */
  reason?: string;
}

const ALLOWED_CONTAINED_PROVIDER: InstanceProvider = 'codex';

/**
 * `resolvedProvider` is the `provider` field of a
 * `resolveAutomationSpawnTarget` result — `undefined` or `'auto'` both mean
 * "not concretely resolved to Codex", so both are treated as a refusal; a
 * `contained` run can never assume an unresolved provider will happen to be
 * Codex once the CLI-detection layer picks one.
 */
export function checkContainedExecutionGate(
  executionProfile: AutomationExecutionProfile | undefined,
  resolvedProvider: InstanceProvider | undefined,
): ContainedExecutionGateResult {
  if (executionProfile !== 'contained') {
    return { ok: true };
  }
  if (resolvedProvider === ALLOWED_CONTAINED_PROVIDER) {
    return { ok: true };
  }
  const providerLabel = resolvedProvider && resolvedProvider !== 'auto' ? resolvedProvider : 'auto';
  return {
    ok: false,
    reason: `Contained runs require Codex — ${providerLabel} cannot enforce isolation.`,
  };
}
