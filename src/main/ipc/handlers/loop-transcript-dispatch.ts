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
export async function appendLoopIterationTranscript(
  state: LoopState,
  iteration: LoopIteration,
  chatService: ChatService,
  instanceManager: InstanceManager,
): Promise<void> {
  if (iteration.transcriptBound) {
    return;
  }
  const event = buildLoopIterationChatEvent(state, iteration);
  if (!event) {
    return;
  }
  const chat = chatService.tryGetChat(state.chatId);
  if (chat) {
    // AWAIT (not fire-and-forget): the iteration hook that calls this is awaited
    // by the LoopCoordinator, so awaiting here guarantees each iteration's
    // assistant turn is durably in the ledger *before* the loop advances — and
    // therefore before the terminal summary bumps the chat's lineage epoch. A
    // fire-and-forget append could lose the race against an immediate follow-up
    // send that consumes and clears the rebuild flag before the loop work has
    // landed, permanently skipping it from the rebuilt context.
    try {
      await chatService.appendSystemEvent(event);
    } catch (error) {
      logger.warn('Failed to append loop iteration to chat transcript', {
        loopRunId: state.id,
        chatId: state.chatId,
        seq: iteration.seq,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
  const chat = chatService.tryGetChat(state.chatId);
  if (chat) {
    // Mark the session lineage as dirty FIRST (synchronously) so the next
    // sendMessage rebuilds context from the ledger — which by now durably
    // contains every loop iteration as an assistant turn, because the iteration
    // hook awaits appendLoopIterationTranscript before the loop reaches this
    // terminal state. Setting the flag before the async recap append closes the
    // window where an instant follow-up could send before the flag was set.
    // The binding is persisted to the DB so it survives restarts (this replaces
    // the in-memory queueLoopHandoff band-aid).
    //
    // Isolated in its own try/catch: the binding write and the recap card are
    // independent, so a binding-store failure must not prevent the user-facing
    // recap from rendering.
    try {
      chatService.bumpLineageEpoch(state.chatId);
    } catch (error) {
      logger.warn('Failed to bump loop lineage epoch; chat recap will still render', {
        loopRunId: state.id,
        chatId: state.chatId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // Write the human-facing recap card to the chat ledger. Fire-and-forget is
    // fine: it's a system-role event that the ledger rebuild filters out, so its
    // timing never affects continuity.
    void chatService.appendSystemEvent(buildLoopTerminalChatSummary(state)).catch((error) => {
      logger.warn('Failed to append loop terminal summary to chat transcript', {
        loopRunId: state.id,
        chatId: state.chatId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return;
  }
  const instance = instanceManager.getInstance(state.chatId);
  if (instance) {
    const summary = buildLoopTerminalChatSummary(state);
    instanceManager.emitSystemMessage(state.chatId, summary.content, summary.metadata);
    // Instance-bound loops (started from instance-detail view) have no ledger
    // thread; fall back to the existing summary-based handoff for continuity.
    const handoff = buildLoopContextHandoff(state);
    instanceManager.queueContinuityPreamble(state.chatId, handoff);
    return;
  }
  logger.warn('loop terminal chatId resolves to neither chat nor instance — summary not persisted', {
    loopRunId: state.id,
    chatId: state.chatId,
  });
}
