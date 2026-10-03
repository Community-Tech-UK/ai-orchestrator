import type { ThreadGoalStatus } from './app-server-types';
import type { CodexAppServerRuntimeClient } from './app-server-thread-runtime';

/** Unknown goal state cannot authorize a competing Harness recovery prompt. */
export async function readCodexContinuationOwnership(
  known: ThreadGoalStatus | null | undefined,
  client: Pick<CodexAppServerRuntimeClient, 'request'> | null | undefined,
  threadId: string | null | undefined,
): Promise<boolean> {
  if (known !== undefined) return known === 'active';
  if (!client || !threadId) return true;
  try {
    const response = await client.request('thread/goal/get', { threadId }, 5_000);
    if (response.goal === null) return false;
    const status = response.goal?.status;
    return status !== 'paused' && status !== 'complete';
  } catch {
    return true;
  }
}

/** Native controlled recovery continues only an explicitly active goal. */
export async function readCodexActiveGoal(
  known: ThreadGoalStatus | null | undefined,
  client: Pick<CodexAppServerRuntimeClient, 'request'> | null | undefined,
  threadId: string | null | undefined,
): Promise<boolean> {
  if (known !== undefined) return known === 'active';
  if (!client || !threadId) return false;
  try {
    const { goal } = await client.request('thread/goal/get', { threadId }, 5_000);
    return goal?.status === 'active';
  } catch {
    return false;
  }
}
