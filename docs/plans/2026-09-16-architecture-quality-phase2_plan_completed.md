# Architecture quality Phase 2 — first increments

Status: completed
Date: 2026-09-16
Parent: `docs/plans/2026-09-15-architecture-quality-remediation_plan.md`

## Scope

Land independently-safe Phase 2 items without the full InstanceManager facade split.

## Implementation notes

- 2.1 `instance-permissions-facade.ts` owns optional project-rule loading, subagent inheritance, CLI action→scope mapping, path normalization, and gate metadata. `handleInputRequired` stays on `InstanceManager` because it still needs manager-owned pending-request maps and lifecycle events.
- 2.2 `InstanceCommunicationCircuitBreakers` is the empty-response collaborator. Overflow/retry maps remain on the communication manager.
- 2.3 was already a structural adapter guard (landed with Phase 1).
- 2.4 `MemoryCrossInstanceCommStore` holds bridges/messages/subscriptions; `CrossInstanceCommService` keeps EventEmitter pub/sub and injects the store. `createForTesting` plus `getCrossInstanceCommService` make the singleton pattern match `AGENTS.md`.
- 2.5 `parseCliShadowReport` already exported from `provider-runtime-registry.ts` (prior increment).
- 2.6 `InstanceManager` accepts optional constructor-injected `ToolLoopWiringDeps`. Production still uses lazy default lookups so existing post-construction spies keep working; `resolveToolLoopWiringDeps` lives in `instance-tool-loop-wiring.ts`.
- 2.7 `HibernationManager._resetForTesting` now assigns `null` instead of casting the instance away. `HotModelSwitcher`, `ProviderRuntimeRegistry`, and `AgentTreePersistence` already followed the documented pattern.

## Remaining

Deeper InstanceManager / InstanceCommunicationManager decomposition (full permission request flow, overflow/retry, history) stays incremental under the LOC-ratchet plan. This phase's numbered items have their first landable extractions.

## Verification

Targeted specs: `cross-instance-comm.spec.ts`, `instance-communication-circuit-breaker.spec.ts`, `instance-permissions-facade.spec.ts`, `instance-communication.spec.ts`, `instance-manager.send-input.spec.ts`, hibernation specs.
