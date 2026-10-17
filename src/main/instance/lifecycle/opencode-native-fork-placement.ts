import type { NodePlacementPrefs } from '../../../shared/types/worker-node.types';
import { normalizeRecoveryNodePlacement } from '../../session/session-recovery-node-placement';

/** An already cloned native identity must never reach a legacy OpenCode install. */
export function requireOpenCodeNativeForkPlacement(value: unknown): NodePlacementPrefs {
  const placement = normalizeRecoveryNodePlacement(value);
  if (placement?.requiresOpenCodeMajor === 1) {
    throw new Error('Native OpenCode forks require OpenCode 2; version 1 placement conflicts with this request.');
  }
  return { ...placement, requiresCli: placement?.requiresCli ?? 'opencode', requiresOpenCodeMajor: 2 };
}
