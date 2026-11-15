import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import {
  SessionWatcherAnswerYesPayloadSchema,
  SessionWatcherSetMutedPayloadSchema,
  SessionWatcherTypingHoldPayloadSchema,
} from '@contracts/schemas/session-watcher';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import type { Instance } from '../../../shared/types/instance.types';
import type { InstanceSendInputOptions } from '../../instance/instance-input-cancellation';
import { getLogger } from '../../logging/logger';
import { getSessionContinuityManager } from '../../session/session-continuity';
import { getWatcherAttention, type WatcherAttention } from '../../session-watcher/watcher-attention';
import { hashSessionId, recordWatcherDecision } from '../../session-watcher/watcher-decision-log';
import { WATCHER_YES_MESSAGE } from '../../session-watcher/watcher-replies';
import { getWatcherTypingHold, type WatcherTypingHold } from '../../session-watcher/watcher-wiring';

const logger = getLogger('SessionWatcherHandlers');

/** The longest a typing report may hold the watcher's reply, whatever the renderer asks for. */
export const WATCHER_TYPING_HOLD_CAP_MS = 3 * 60_000;

export interface SessionWatcherActionDeps {
  getInstance(instanceId: string): Pick<Instance, 'id' | 'watcherMuted' | 'requestCount'> | undefined;
  sendInput(instanceId: string, message: string, attachments: undefined, options: InstanceSendInputOptions): Promise<void>;
  persistMuted(instanceId: string, muted: boolean): void;
  attention: Pick<WatcherAttention, 'get' | 'clear'>;
  typingHold: Pick<WatcherTypingHold, 'set'>;
  now(): number;
}

const answering = new Set<string>();

/**
 * The user's own "Yes, go ahead" on a session the watcher handed back. Sent as the user's answer, not as automatic
 * input and without the typed-by-a-person origin; the stored message carries the question it answered.
 */
export async function answerWatcherYes(deps: SessionWatcherActionDeps, payload: { instanceId: string; requestCount: number }): Promise<void> {
  const { instanceId, requestCount } = payload;
  const flag = deps.attention.get(instanceId);
  if (!flag || flag.requestCount !== requestCount) throw new Error('This question has already been dealt with. Nothing was sent.');
  if (!flag.acceptsYes) throw new Error('This question needs a written answer. Open the session to reply.');
  const instance = deps.getInstance(instanceId);
  if (!instance) throw new Error('This session is no longer open.');
  // The session has moved on since the question was shown: a yes now would approve something else.
  if (instance.requestCount !== flag.requestCount) throw new Error('This question has already been dealt with. Nothing was sent.');
  if (answering.has(instanceId)) throw new Error('Your answer is already being sent.');
  answering.add(instanceId);
  try {
    await deps.sendInput(instanceId, WATCHER_YES_MESSAGE, undefined, { watcherApproval: { question: flag.question } });
  } finally {
    answering.delete(instanceId);
  }
  deps.attention.clear(instanceId);
  recordWatcherDecision({ event: 'follow-up', kind: 'yes-clicked', session: hashSessionId(instanceId), requestCount });
}

/** Switches the watcher off or back on for one session. Muting also drops that session's open flag. */
export function setWatcherMuted(deps: SessionWatcherActionDeps, payload: { instanceId: string; muted: boolean }): void {
  const { instanceId, muted } = payload;
  const instance = deps.getInstance(instanceId);
  if (!instance) throw new Error('This session is no longer open.');
  const flag = deps.attention.get(instanceId);
  instance.watcherMuted = muted;
  deps.persistMuted(instanceId, muted);
  if (!muted) return;
  deps.attention.clear(instanceId);
  recordWatcherDecision({ event: 'follow-up', kind: 'muted', session: hashSessionId(instanceId), requestCount: flag?.requestCount ?? instance.requestCount });
}

/** The user is typing in this session or has a message queued. The hold is capped here; 0 releases it. */
export function setWatcherTypingHold(deps: SessionWatcherActionDeps, payload: { instanceId: string; untilMs: number }): void {
  deps.typingHold.set(payload.instanceId, Math.min(payload.untilMs, deps.now() + WATCHER_TYPING_HOLD_CAP_MS));
}

function failure(code: string, error: unknown): IpcResponse {
  return { success: false, error: { code, message: error instanceof Error ? error.message : String(error), timestamp: Date.now() } };
}

/**
 * Renderer-only. Nothing here is reachable from an MCP tool or an orchestrator command, and every handler refuses
 * a sender that is not the main window.
 */
export function registerSessionWatcherHandlers(deps: {
  getInstance: SessionWatcherActionDeps['getInstance'];
  sendInput: SessionWatcherActionDeps['sendInput'];
  ensureTrustedSender: (event: IpcMainInvokeEvent, channel: string) => IpcResponse | null;
}): void {
  const actions: SessionWatcherActionDeps = {
    getInstance: deps.getInstance,
    sendInput: deps.sendInput,
    persistMuted: (instanceId, muted) => {
      getSessionContinuityManager().updateState(instanceId, { watcherMuted: muted })
        .catch((error: unknown) => logger.warn('Could not save the session watcher mute', { error: String(error) }));
    },
    get attention() { return getWatcherAttention(); },
    typingHold: getWatcherTypingHold(),
    now: Date.now,
  };
  const register = (channel: string, code: string, run: (payload: unknown) => unknown): void => {
    ipcMain.handle(channel, async (event, payload: unknown): Promise<IpcResponse> => {
      const denied = deps.ensureTrustedSender(event, channel);
      if (denied) return denied;
      try {
        return { success: true, data: await run(payload) };
      } catch (error) {
        return failure(code, error);
      }
    });
  };
  register(IPC_CHANNELS.SESSION_WATCHER_LIST_FLAGS, 'SESSION_WATCHER_LIST_FAILED', () => getWatcherAttention().list());
  register(IPC_CHANNELS.SESSION_WATCHER_ANSWER_YES, 'SESSION_WATCHER_ANSWER_FAILED', (payload) =>
    answerWatcherYes(actions, SessionWatcherAnswerYesPayloadSchema.parse(payload)));
  register(IPC_CHANNELS.SESSION_WATCHER_SET_MUTED, 'SESSION_WATCHER_MUTE_FAILED', (payload) =>
    setWatcherMuted(actions, SessionWatcherSetMutedPayloadSchema.parse(payload)));
  register(IPC_CHANNELS.SESSION_WATCHER_TYPING_HOLD, 'SESSION_WATCHER_TYPING_FAILED', (payload) =>
    setWatcherTypingHold(actions, SessionWatcherTypingHoldPayloadSchema.parse(payload)));
}
