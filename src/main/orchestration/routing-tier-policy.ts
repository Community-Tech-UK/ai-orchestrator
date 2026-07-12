/**
 * Operator-controlled model tier per orchestration gate.
 *
 * `resolveModelForInvocation` used to hardcode the tier for each gate: loop,
 * verify, review and debate (all of which share the `scaffolding`/`synthesis`
 * routing intents) were pinned to `balanced`, and only `workflow` kept the
 * router's keyword heuristic. That was the right *default* but it was not
 * tunable, so the only way to move an expensive gate onto a cheaper model was
 * to edit the code.
 *
 * This module makes that mapping a setting. The defaults reproduce the previous
 * hardcoded behaviour exactly (see DEFAULT_ORCHESTRATION_ROUTING_POLICY), so
 * nothing changes until a key is overridden.
 *
 * Parsing is deliberately fail-soft and per-key: a malformed blob, a bad value,
 * or an unknown key falls back to that key's default rather than throwing. A
 * settings typo must never take orchestration down.
 *
 * Rescued from codex/cross-model-remote-node-effectiveness (tag
 * `preserve/routing-tier-policy`), rebased onto the rewritten default-invokers.
 * The original defaults pinned `review` and `debateSynthesis` to `powerful`;
 * those are deliberately NOT carried over — the claude-fanout audit measured
 * debate synthesis on the powerful tier at 38.3% of that run's spend.
 */
import {
  DEFAULT_ORCHESTRATION_ROUTING_POLICY,
  type OrchestrationRoutingPolicyKey,
  type OrchestrationRoutingPolicyValue,
} from '../../shared/types/settings.types';
import { isModelTier } from '../../shared/types/provider.types';
import { getSettingsManager } from '../core/config/settings-manager';
import type { ModelTier } from '../routing';

export type RoutingTierPolicy = Record<OrchestrationRoutingPolicyKey, OrchestrationRoutingPolicyValue>;

export const ROUTING_POLICY_KEYS: readonly OrchestrationRoutingPolicyKey[] = [
  'loop',
  'workflow',
  'verify',
  'review',
  'debate',
  'debateSynthesis',
];

function defaultRoutingPolicy(): RoutingTierPolicy {
  return { ...DEFAULT_ORCHESTRATION_ROUTING_POLICY };
}

function isPolicyValue(value: unknown): value is OrchestrationRoutingPolicyValue {
  return value === 'auto' || (typeof value === 'string' && isModelTier(value));
}

/**
 * Parse the raw setting into a complete policy. Every key is always present:
 * anything missing or invalid keeps its default, so callers never see a hole.
 */
export function parseRoutingTierPolicy(raw: unknown): RoutingTierPolicy {
  const policy = defaultRoutingPolicy();
  if (typeof raw !== 'string' || raw.trim().length === 0) return policy;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return policy;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return policy;

  const obj = parsed as Record<string, unknown>;
  for (const key of ROUTING_POLICY_KEYS) {
    const value = obj[key];
    if (isPolicyValue(value)) policy[key] = value;
  }
  return policy;
}

/**
 * The tier to pin this gate to, or `undefined` when the policy says `auto`
 * (i.e. defer to the router's keyword-complexity heuristic).
 */
export function resolveRoutingPolicyTier(
  key: OrchestrationRoutingPolicyKey,
  rawPolicyJson: unknown = getSettingsManager().getAll().orchestrationRoutingPolicyJson,
): ModelTier | undefined {
  const value = parseRoutingTierPolicy(rawPolicyJson)[key];
  return value === 'auto' ? undefined : value;
}
