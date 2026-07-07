/**
 * Instance module - Manages Claude Code instances
 *
 * This module is organized into focused, single-responsibility sub-modules:
 * - InstanceManager: Main coordinator (thin facade)
 * - InstanceStateManager: State, adapters, batch updates
 * - InstanceLifecycleManager: Create, terminate, restart, mode changes
 * - InstanceCommunicationManager: Adapter events, message passing
 * - InstanceContextManager: RLM and unified memory context
 * - InstanceOrchestrationManager: Child spawning, fast-path retrieval
 * - InstancePersistenceManager: Session export, import, storage
 */

// Main coordinator
export { InstanceManager } from './instance-manager';

// Sub-managers (exported for advanced use cases and testing)
export { InstanceStateManager } from './instance-state';
export { InstanceLifecycleManager, type LifecycleDependencies } from './instance-lifecycle';
export { InstanceCommunicationManager, type CommunicationDependencies } from './instance-communication';
export { InstanceContextManager, type ContextConfig, DEFAULT_CONTEXT_CONFIG } from './instance-context';
export { InstanceOrchestrationManager, type OrchestrationDependencies } from './instance-orchestration';
export { InstancePersistenceManager, type PersistenceDependencies } from './instance-persistence';

// Types
export type {
  RlmContextInfo,
  ContextBudget,
  RankedSection,
  UnifiedMemoryContextInfo,
  FastPathResult
} from './instance-types';
