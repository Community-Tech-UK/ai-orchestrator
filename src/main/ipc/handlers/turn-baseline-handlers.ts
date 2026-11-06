/**
 * Turn file-change handler.
 *
 * Attaches the per-turn file baseline to the instance manager, so a snapshot is
 * taken whenever a turn starts and settles whether or not anyone is looking at
 * that session, and answers the renderer's one question: which files changed
 * while this turn ran. See `TurnFileBaselineService`.
 */

import { IPC_CHANNELS } from '@contracts/channels';
import { VcsTurnFileChangesPayloadSchema } from '@contracts/schemas/workspace-tools';
import type { z } from 'zod';
import {
  getTurnFileBaselineService,
  type TurnBaselineEventSource,
  type TurnBaselineInstanceInfo,
  type TurnBaselineResult,
} from '../../vcs/turn-file-baseline';
import { registerValidatedIpcHandler, type EnsureTrustedSender } from '../validated-handler';

export interface TurnBaselineHandlerDeps {
  instanceManager: TurnBaselineEventSource & {
    getInstance(instanceId: string): TurnBaselineInstanceInfo | undefined;
  };
  ensureTrustedSender?: EnsureTrustedSender;
}

export function registerTurnBaselineHandlers(deps: TurnBaselineHandlerDeps): void {
  const service = getTurnFileBaselineService();
  service.attach(deps.instanceManager, (instanceId) => {
    const instance = deps.instanceManager.getInstance(instanceId);
    return instance
      ? { workingDirectory: instance.workingDirectory, executionLocation: instance.executionLocation }
      : undefined;
  });
  registerValidatedIpcHandler<z.infer<typeof VcsTurnFileChangesPayloadSchema>, TurnBaselineResult>(
    IPC_CHANNELS.VCS_TURN_FILE_CHANGES,
    VcsTurnFileChangesPayloadSchema,
    async (payload) => ({ success: true, data: await service.getResult(payload.instanceId, payload.turnKey) }),
    { ensureTrustedSender: deps.ensureTrustedSender },
  );
}
