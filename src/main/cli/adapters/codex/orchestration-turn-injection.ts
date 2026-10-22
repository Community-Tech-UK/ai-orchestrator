import { getLogger } from '../../../logging/logger';
import { errorDiagnostic } from '../../../logging/source-diagnostics';
import type { AppServerNotification } from './app-server-types';
import { developerMessageItem, type CodexAppServerThreadRuntime } from './app-server-thread-runtime';
import type { RunningTurnInjection } from './orchestration-response-send';

const logger = getLogger('CodexCliAdapter');

/**
 * Root items that run a tool locally; Codex samples the model again once one
 * finishes. `webSearch` is left out: it can run inside the sampling step that
 * was already streaming, so its completion proves nothing.
 */
const TOOL_ITEM_TYPES: ReadonlySet<string> = new Set([
  'commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall', 'imageView',
]);

export const ORCHESTRATION_REDELIVERY_NOTE =
  'Harness re-delivery: the orchestration response below was added while your previous turn was finishing, '
  + 'so you may not have seen it.';

type InjectionRuntime = Pick<CodexAppServerThreadRuntime, 'getClient' | 'getThreadId' | 'getRunningTurn'>;

/**
 * Adds an orchestration response to the running Codex turn as a developer
 * item. Waiting for the turn to end failed in session x3po7817o: one turn ran
 * for eight hours, so a consensus result timed out after 30 minutes unread.
 *
 * Codex reads the item at the turn's next sampling step. A tool call that
 * finishes after the item was accepted proves one more step ran. Without one,
 * the turn may have ended on a step that started before the item arrived, so
 * `redeliver` sends the response again as its own turn, at most once.
 */
export async function injectOrchestrationIntoRunningTurn(
  message: string,
  runtime: InjectionRuntime,
  redeliver: (message: string) => Promise<void>,
): Promise<RunningTurnInjection> {
  const client = runtime.getClient();
  const threadId = runtime.getThreadId();
  const turn = runtime.getRunningTurn();
  if (!client || !threadId || !turn) return 'not-running';

  let accepted = false;
  let read = false;
  const unsubscribe = client.subscribeNotifications((notification) => {
    if (accepted && completesRootTool(notification, threadId, turn.turnId)) read = true;
  });
  try {
    await client.request('thread/inject_items', { threadId, items: [developerMessageItem(message)] });
  } catch (error) {
    unsubscribe();
    if (turn.state.completed) return 'not-running';
    logger.warn('Codex refused an orchestration response for the running turn', {
      threadId, turnId: turn.turnId, ...errorDiagnostic(error),
    });
    return 'failed';
  }
  // A read proof that arrives in the same chunk as the reply is missed; that only costs a duplicate.
  accepted = true;
  if (turn.state.completed) {
    // It landed after the turn ended, so no turn will act on it; the caller sends it as a new turn.
    unsubscribe();
    return 'not-running';
  }

  void turn.state.completion
    .then(
      (state) => !read && !state.error && (state.finalTurn?.status ?? 'completed') === 'completed',
      () => false,
    )
    .then((unread) => {
      unsubscribe();
      if (!unread || message.startsWith(ORCHESTRATION_REDELIVERY_NOTE)) return;
      logger.info('Re-delivering an orchestration response the finished Codex turn may not have read', {
        threadId, turnId: turn.turnId,
      });
      return redeliver(`${ORCHESTRATION_REDELIVERY_NOTE}\n\n${message}`);
    })
    // The item stays in the thread history, so a later turn still sees it.
    .catch((error: unknown) => logger.warn('Re-delivering an orchestration response failed', errorDiagnostic(error)));
  return 'delivered';
}

function completesRootTool(notification: AppServerNotification, threadId: string, turnId: string): boolean {
  const { method, params } = notification;
  if (method !== 'item/completed' || params['threadId'] !== threadId) return false;
  if (typeof params['turnId'] === 'string' && params['turnId'] !== turnId) return false;
  const type = (params['item'] as { type?: unknown } | undefined)?.type;
  return typeof type === 'string' && TOOL_ITEM_TYPES.has(type);
}
