import type { ExecutionLocation } from '../../../../shared/types/worker-node.types';

export interface DashboardProjectContext {
  workingDirectory: string;
  nodeId: string | null;
}

export interface DashboardProjectContextInput {
  selectedInstance: {
    workingDirectory: string | null | undefined;
    executionLocation?: ExecutionLocation | null;
  } | null;
  selectedChat: {
    currentCwd: string | null | undefined;
  } | null;
  previewConversation: {
    workingDirectory: string | null | undefined;
    executionLocation?: ExecutionLocation | null;
  } | null;
  draftWorkingDirectory: string | null | undefined;
  draftNodeId: string | null;
  isScratch: (workingDirectory: string) => boolean;
}

export function resolveDashboardProjectContext(
  input: DashboardProjectContextInput,
): DashboardProjectContext | null {
  if (input.selectedInstance) {
    return contextFromWorkingDirectory(
      input.selectedInstance.workingDirectory,
      input.selectedInstance.executionLocation?.type === 'remote'
        ? input.selectedInstance.executionLocation.nodeId
        : null,
      input.isScratch,
    );
  }

  if (input.selectedChat) {
    return contextFromWorkingDirectory(input.selectedChat.currentCwd, null, input.isScratch);
  }

  if (input.previewConversation) {
    return contextFromWorkingDirectory(
      input.previewConversation.workingDirectory,
      input.previewConversation.executionLocation?.type === 'remote'
        ? input.previewConversation.executionLocation.nodeId
        : null,
      input.isScratch,
    );
  }

  return contextFromWorkingDirectory(input.draftWorkingDirectory, input.draftNodeId, input.isScratch);
}

function contextFromWorkingDirectory(
  workingDirectory: string | null | undefined,
  nodeId: string | null,
  isScratch: (workingDirectory: string) => boolean,
): DashboardProjectContext | null {
  const normalized = workingDirectory?.trim() ?? '';
  if (!normalized || isScratch(normalized)) {
    return null;
  }

  return {
    workingDirectory: normalized,
    nodeId,
  };
}
