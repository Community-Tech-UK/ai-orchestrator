/**
 * Marks the session James starts from the Set aside tab as that folder's Set aside agent. The queue sets it
 * (plan-queue-set-aside.ts), and session continuity carries it across a restart, because a revived session gets
 * new metadata and would otherwise lose the agent's tools.
 */
export const SET_ASIDE_FOLDER_METADATA = 'planQueueSetAsideFolder';

/** The folder this session sorts out, or undefined for every other session. */
export function setAsideFolderOf(metadata: Record<string, unknown> | undefined): string | undefined {
  const folder = metadata?.[SET_ASIDE_FOLDER_METADATA];
  return typeof folder === 'string' && folder ? folder : undefined;
}
