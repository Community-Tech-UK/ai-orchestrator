import { randomUUID } from 'node:crypto';
import type { InstanceManager } from '../../instance/instance-manager';
import type { LoopIteration, LoopState } from '../../../shared/types/loop.types';
import type { getChatService } from '../../chats';
import {
  buildLoopContextHandoff,
  buildLoopInterveneChatEvent,
  buildLoopIterationChatEvent,
  buildLoopStartChatEvent,
  buildLoopTerminalChatSummary,
} from '../../orchestration/loop-chat-summary';
import { getLogger } from '../../logging/logger';

const logger = getLogger('LoopTranscriptDispatch');

type ChatService = ReturnType<typeof getChatService>;

/**
 * The loop's `state.chatId` can be either a chat id (when the loop was started
 * from `chat-detail.component`) or an instance id (when it was started from
 * `instance-detail.component` — see `instance-detail.component.html` where
 * `[loopChatId]="inst.id"` is passed). Both surfaces share the LOOP_START IPC
 * but write to different stores. We dispatch here so the kickoff prompt lands
 * in the correct transcript and triggers the right auto-rename hook for the
 * surface the user is actually looking at.
 */
export function appendLoopStartPrompt(
  state: LoopState,
  chatService: ChatService,
  instanceManager: InstanceManager,
): void {
  const chat = chatService.tryGetChat(state.chatId);
  if (chat) {
    void chatService.appendSystemEvent({
      ...buildLoopStartChatEvent(state),
      autoName: true,
    }).catch((error) => {
      logger.warn('Failed to append loop start prompt to chat transcript', {
        loopRunId: state.id,
        chatId: state.chatId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return;
  }
  const instance = instanceManager.getInstance(state.chatId);
  if (instance) {
    instanceManager.appendSyntheticUserMessage(state.chatId, state.config.initialPrompt, {
      autoTitle: true,
      metadata: {
        kind: 'loop-start',
        loopRunId: state.id,
        workspaceCwd: state.config.workspaceCwd,
      },
    });
    return;
  }
  logger.warn('loop:started chatId resolves to neither chat nor instance — prompt not persisted', {
    loopRunId: state.id,
    chatId: state.chatId,
  });
}

export function appendLoopInterveneMessage(
  state: LoopState,
  message: string,
  chatService: ChatService,
  instanceManager: InstanceManager,
): void {
  const interventionId = randomUUID();
  const chat = chatService.tryGetChat(state.chatId);
  if (chat) {
    void chatService.appendSystemEvent(buildLoopInterveneChatEvent({
      state,
      interventionId,
      message,
    })).catch((error) => {
      logger.warn('Failed to append loop intervene message to chat transcript', {
        loopRunId: state.id,
        chatId: state.chatId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return;
  }
  const instance = instanceManager.getInstance(state.chatId);
  if (instance) {
    instanceManager.appendSyntheticUserMessage(state.chatId, message, {
      metadata: {
        kind: 'loop-intervene',
        loopRunId: state.id,
        interventionId,
      },
    });
    return;
  }
  logger.warn('loop intervene chatId resolves to neither chat nor instance — message not persisted', {
    loopRunId: state.id,
    chatId: state.chatId,
  });
}

/**
 * Append a completed loop iteration's closing message to the canonical
 * transcript so the interactive model has memory of the loop's work.
 *
 * Dispatches by surface exactly like {@link appendLoopTerminalSummary}: a
 * chat-detail loop writes a durable, idempotent assistant event to the chat
 * ledger; an instance-detail loop emits into the instance's output buffer.
 *
 * Iterations that ran in the chat's borrowed live adapter are skipped — their
 * assistant stream already landed in the transcript as a normal turn, so a
 * second write here would duplicate it.
 */
export function appendLoopIterationTranscript(
  state: LoopState,
  iteration: LoopIteration,
  chatService: ChatService,
  instanceManager: InstanceManager,
): void {
  if (iteration.transcriptBound) {
    return;
  }
  const event = buildLoopIterationChatEvent(state, iteration);
  if (!event) {
    return;
  }
  const chat = chatService.tryGetChat(state.chatId);
  if (chat) {
    void chatService.appendSystemEvent(event).catch((error) => {
      logger.warn('Failed to append loop iteration to chat transcript', {
        loopRunId: state.id,
        chatId: state.chatId,
        seq: iteration.seq,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return;
  }
  const instance = instanceManager.getInstance(state.chatId);
  if (instance) {
    instanceManager.emitSystemMessage(state.chatId, event.content, event.metadata);
    return;
  }
  logger.warn('loop iteration chatId resolves to neither chat nor instance — turn not persisted', {
    loopRunId: state.id,
    chatId: state.chatId,
    seq: iteration.seq,
  });
}

export function appendLoopTerminalSummary(
  state: LoopState,
  chatService: ChatService,
  instanceManager: InstanceManager,
): void {
  // Silent context handoff for the NEXT interactive turn: the loop ran in its
  // own CLI session, so the chat's model never saw it. Without this, follow-ups
  // ("were those issues resolved?") have no antecedent. Distinct from the
  // visible recap card below.
  const handoff = buildLoopContextHandoff(state);
  const chat = chatService.tryGetChat(state.chatId);
  if (chat) {
    void chatService.appendSystemEvent(buildLoopTerminalChatSummary(state)).catch((error) => {
      logger.warn('Failed to append loop terminal summary to chat transcript', {
        loopRunId: state.id,
        chatId: state.chatId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    chatService.queueLoopHandoff(state.chatId, handoff);
    return;
  }
  const instance = instanceManager.getInstance(state.chatId);
  if (instance) {
    const summary = buildLoopTerminalChatSummary(state);
    instanceManager.emitSystemMessage(state.chatId, summary.content, summary.metadata);
    instanceManager.queueContinuityPreamble(state.chatId, handoff);
    return;
  }
  logger.warn('loop terminal chatId resolves to neither chat nor instance — summary not persisted', {
    loopRunId: state.id,
    chatId: state.chatId,
  });
}
