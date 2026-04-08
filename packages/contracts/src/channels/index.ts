/**
 * IPC channel definitions — single source of truth.
 *
 * All domain-grouped channel objects are merged into IPC_CHANNELS,
 * which is type-identical to the object previously defined in
 * src/shared/types/ipc.types.ts.
 */

import { INSTANCE_CHANNELS } from './instance.channels';
import { FILE_CHANNELS } from './file.channels';
import { SESSION_CHANNELS } from './session.channels';
import { ORCHESTRATION_CHANNELS } from './orchestration.channels';
import { MEMORY_CHANNELS } from './memory.channels';
import { PROVIDER_CHANNELS } from './provider.channels';
import { INFRASTRUCTURE_CHANNELS } from './infrastructure.channels';
import { COMMUNICATION_CHANNELS } from './communication.channels';
import { LEARNING_CHANNELS } from './learning.channels';
import { WORKSPACE_CHANNELS } from './workspace.channels';

export {
  INSTANCE_CHANNELS,
  FILE_CHANNELS,
  SESSION_CHANNELS,
  ORCHESTRATION_CHANNELS,
  MEMORY_CHANNELS,
  PROVIDER_CHANNELS,
  INFRASTRUCTURE_CHANNELS,
  COMMUNICATION_CHANNELS,
  LEARNING_CHANNELS,
  WORKSPACE_CHANNELS,
};

/**
 * Combined IPC_CHANNELS — drop-in replacement for the object previously
 * defined in src/shared/types/ipc.types.ts.
 */
export const IPC_CHANNELS = {
  ...INSTANCE_CHANNELS,
  ...FILE_CHANNELS,
  ...SESSION_CHANNELS,
  ...ORCHESTRATION_CHANNELS,
  ...MEMORY_CHANNELS,
  ...PROVIDER_CHANNELS,
  ...INFRASTRUCTURE_CHANNELS,
  ...COMMUNICATION_CHANNELS,
  ...LEARNING_CHANNELS,
  ...WORKSPACE_CHANNELS,
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
