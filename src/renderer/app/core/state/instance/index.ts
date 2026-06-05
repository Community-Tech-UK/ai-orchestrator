/**
 * Instance Store - Barrel Exports
 *
 * This module exports all instance store components.
 * Import from this file for clean, organized imports.
 *
 * @example
 * import { InstanceStore, Instance, InstanceStatus } from './instance';
 */

// Main Store (facade/coordinator)
export { InstanceStore } from './instance.store';

// Sub-stores (for direct access if needed)
export { InstanceStateService } from './instance-state.service';
export { InstanceQueries } from './instance.queries';
export { InstanceListStore } from './instance-list.store';
export { InstanceSelectionStore } from './instance-selection.store';
export { InstanceOutputStore } from './instance-output.store';
export { InstanceMessagingStore } from './instance-messaging.store';

// Types
export type {
  InstanceStatus,
  ContextUsage,
  OutputMessage,
  InstanceProvider,
  InstanceLaunchMode,
  Instance,
  InstanceStoreState,
  QueuedMessage,
  CreateInstanceConfig,
} from './instance.types';

export { FILE_LIMITS } from './instance.types';
