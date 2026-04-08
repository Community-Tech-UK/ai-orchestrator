/**
 * @ai-orchestrator/contracts
 *
 * Single source of truth for all IPC channel definitions, Zod payload schemas,
 * and transport types used across the main process, preload, and renderer.
 */

export * from './channels/index';

// Schemas and types are imported via sub-paths (@contracts/schemas, @contracts/types)
// to avoid name collisions between Zod-inferred types and interface definitions.
// Channels are re-exported here since they have no collisions.
export type { IpcChannel } from './channels/index';
