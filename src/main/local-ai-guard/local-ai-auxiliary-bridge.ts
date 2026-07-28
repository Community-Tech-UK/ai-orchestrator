import type { AuxiliaryLlmSlot } from '../../shared/types/auxiliary-llm.types';
import type {
  LocalAiEndpointIdentity,
  LocalAiFallbackVerdict,
  LocalAiLocalRouteVerdict,
  LocalAiTarget,
} from '../../shared/types/local-ai-guard.types';
import type { LocalAiFallbackAuthorizationInput } from './local-ai-routing-guard';

export interface LocalAiAuxiliaryHooks {
  findTarget(identity: LocalAiEndpointIdentity): LocalAiTarget | undefined;
  evaluateLocalTarget(input: {
    targetId: string;
    slot: AuxiliaryLlmSlot;
  }): Promise<LocalAiLocalRouteVerdict>;
  acquireTarget(targetId: string): () => void;
  invalidateTarget(targetId: string): void;
  authorizeFallback(input: LocalAiFallbackAuthorizationInput): Promise<LocalAiFallbackVerdict>;
  markFallbackDispatched(eventId: string): void | Promise<void>;
}

const compatibilityHooks: LocalAiAuxiliaryHooks = {
  findTarget: () => undefined,
  evaluateLocalTarget: async () => ({
    eligible: true,
    reason: 'unmanaged-compatibility',
  }),
  acquireTarget: () => () => undefined,
  invalidateTarget: () => undefined,
  authorizeFallback: async (input) => ({
    allowed: input.slotAllowsFrontier,
    disposition: input.slotAllowsFrontier ? 'allowed' : 'blocked',
    policy: input.slotAllowsFrontier ? 'allow-silently' : 'block-paid-fallback',
    routingEventId: 'unmanaged-compatibility',
  }),
  markFallbackDispatched: () => undefined,
};

let hooks = compatibilityHooks;

export function getLocalAiAuxiliaryHooks(): LocalAiAuxiliaryHooks {
  return hooks;
}

export function __setLocalAiAuxiliaryHooksForTesting(
  overrides: LocalAiAuxiliaryHooks,
): void {
  hooks = overrides;
}

export function __resetLocalAiAuxiliaryHooksForTesting(): void {
  hooks = compatibilityHooks;
}

export function installLocalAiAuxiliaryRuntimeHooks(runtime: {
  targets: Pick<import('./local-ai-target-repository').LocalAiTargetRepository, 'findByEndpoint'>;
  routing: Pick<import('./local-ai-routing-guard').LocalAiRoutingGuard, 'evaluateLocalTarget' | 'authorizeFallback' | 'markFallbackDispatched'>;
  activity: Pick<import('./local-ai-activity-registry').LocalAiActivityRegistry, 'acquire'>;
  scheduler: Pick<import('./local-ai-health-scheduler').LocalAiHealthScheduler, 'targetChanged'>;
}): () => void {
  const installed: LocalAiAuxiliaryHooks = {
    findTarget: (identity) => runtime.targets.findByEndpoint(identity),
    evaluateLocalTarget: (input) => runtime.routing.evaluateLocalTarget(input),
    acquireTarget: (targetId) => runtime.activity.acquire(targetId),
    invalidateTarget: (targetId) => runtime.scheduler.targetChanged(targetId),
    authorizeFallback: (input) => runtime.routing.authorizeFallback(input),
    markFallbackDispatched: (eventId) => runtime.routing.markFallbackDispatched(eventId),
  };
  hooks = installed;
  return () => {
    if (hooks === installed) hooks = compatibilityHooks;
  };
}
