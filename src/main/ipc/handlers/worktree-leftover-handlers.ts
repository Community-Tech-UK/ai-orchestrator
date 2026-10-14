import { IPC_CHANNELS } from '@contracts/channels';
import { WorktreeLeftoversListPayloadSchema, WorktreeLeftoversPreviewPayloadSchema,
  WorktreeLeftoversRemovePayloadSchema } from '@contracts/schemas/workspace-tools';
import { registerValidatedIpcHandler, type EnsureTrustedSender } from '../validated-handler';
import { LeftoverWorktreeRemoval } from '../../workspace/git/leftover-worktree-removal';
import { createLeftoverRuntimeDependencies, listRuntimeLeftoverWorktrees,
  type LeftoverLiveSession } from '../../workspace/git/leftover-worktree-runtime';
import type { LeftoverReportDependencies } from '../../workspace/git/leftover-worktree-report';

export function registerWorktreeLeftoverHandlers(input: {
  getLiveSessions: () => LeftoverLiveSession[];
  reportDependencies?: LeftoverReportDependencies;
  ensureTrustedSender?: EnsureTrustedSender;
}): void {
  const deps = input.reportDependencies ?? createLeftoverRuntimeDependencies(input.getLiveSessions);
  const removal = new LeftoverWorktreeRemoval(deps);
  const options = { ensureTrustedSender: input.ensureTrustedSender };
  registerValidatedIpcHandler(IPC_CHANNELS.WORKTREE_LEFTOVERS_LIST, WorktreeLeftoversListPayloadSchema,
    async (payload) => ({ success: true, data: await listRuntimeLeftoverWorktrees(deps, payload.workingDirectory) }), options);
  registerValidatedIpcHandler(IPC_CHANNELS.WORKTREE_LEFTOVERS_PREVIEW, WorktreeLeftoversPreviewPayloadSchema,
    async (payload) => ({ success: true, data: await removal.previewLeftoverRemoval(payload) }), options);
  registerValidatedIpcHandler(IPC_CHANNELS.WORKTREE_LEFTOVERS_REMOVE, WorktreeLeftoversRemovePayloadSchema,
    async (payload) => ({ success: true, data: await removal.runLeftoverRemoval(payload) }), options);
}
