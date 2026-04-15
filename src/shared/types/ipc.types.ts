/**
 * IPC compatibility shim.
 *
 * @deprecated Import `IPC_CHANNELS` from `@contracts/channels` and IPC payload
 * types from `@contracts/types` directly. This file remains only to preserve
 * existing imports while the Phase 1 contracts migration is in progress.
 */

export { IPC_CHANNELS } from '@contracts/channels';
export type * from '@contracts/types';
