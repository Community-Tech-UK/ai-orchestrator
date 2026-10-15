import type { LoopIteration, LoopState, LoopPendingInputSource } from '../../shared/types/loop.types';
import { loopQuestionNeed } from '../../shared/attention/question-need';
import type { NotificationInput } from '../notifications/notification-service';
import { getLogger } from '../logging/logger';
import { resolveLoopArtifactPaths } from './loop-artifact-paths';
import { readUtf8FileHead } from './bounded-file-read';
import { parseOutstandingSections } from './loop-stage-markdown';
import type { LoopStore } from './loop-store';
import { outstandingRiskHint, OUTSTANDING_DECISION_CAP_HINT } from './loop-outstanding-hints';

const logger = getLogger('LoopOutstandingLive');
export function registerLoopOutstandingLive(deps: {
  coordinator: {
    registerIterationHook(hook: (input: { state: LoopState; iteration: LoopIteration }) => Promise<void>): void;
    intervene(id: string, text: string, kind: 'queue', drain: undefined, source: LoopPendingInputSource): unknown;
  };
  store: Pick<LoopStore, 'listOutstandingItems' | 'upsertOutstandingSnapshot'>;
  send(payload: { loopRunId: string; chatId: string; workspaceCwd: string; newItemIds: string[] }): void;
  notify(input: NotificationInput): unknown;
}): void {
  deps.coordinator.registerIterationHook(async ({ state, iteration }) => {
    try {
      const paths = resolveLoopArtifactPaths(state.config.workspaceCwd, state.id);
      const read = await readUtf8FileHead(paths.outstanding);
      // A truncated snapshot cannot prove an item disappeared. Leave the previous rows intact.
      if (read.truncated) return;
      const before = deps.store.listOutstandingItems({ chatId: state.chatId, status: 'all', limit: 1000 }).filter(item => item.loopRunId === state.id);
      const result = deps.store.upsertOutstandingSnapshot({ state, sections: parseOutstandingSections(read.text), round: iteration.seq });
      if (result.flagged.length) deps.coordinator.intervene(state.id, outstandingRiskHint(result.flagged), 'queue', undefined, 'loop-question');
      const items = deps.store.listOutstandingItems({ chatId: state.chatId, status: 'all', limit: 1000 }).filter(item => item.loopRunId === state.id);
      if (before.filter(item => item.kind === 'decision-applied').length < 10 && items.filter(item => item.kind === 'decision-applied').length >= 10) {
        deps.coordinator.intervene(state.id, OUTSTANDING_DECISION_CAP_HINT, 'queue', undefined, 'loop-question');
      }
      if (result.insertedIds.length || result.changedIds.length || result.closedIds.length) deps.send({ loopRunId: state.id, chatId: state.chatId, workspaceCwd: state.config.workspaceCwd, newItemIds: result.insertedIds });
      const attention = items.filter(item => result.insertedIds.includes(item.id) && loopQuestionNeed(item) !== 'fyi');
      if (attention.length) deps.notify({ kind: 'loop-question', instanceId: state.chatId, title: 'Loop question', body: `“${state.config.initialPrompt.slice(0, 80)}” asks: ${attention[0].text.slice(0, 180)}${attention.length > 1 ? ` and ${attention.length - 1} more` : ''}`, fingerprintFields: { loopRunId: state.id, newItemIds: attention.map(item => item.id) } });
    } catch (error) { logger.warn('Live outstanding capture failed', { loopRunId: state.id, error: String(error) }); }
  });
}
