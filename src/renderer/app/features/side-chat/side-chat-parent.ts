import type { ChatRecord } from '../../../../shared/types/chat.types';
import type { ModelRuntimeTarget } from '../../../../shared/types/local-model-runtime.types';
import type {
  SideChatParentRef,
  SideChatProvider,
  SideChatProviderSelection,
} from '../../../../shared/types/side-chat.types';
import { SIDE_CHAT_PROVIDERS } from '../../../../shared/types/side-chat.types';

/**
 * Stable identity of the session in the main view. A chat is keyed by its id;
 * a session by its history thread id, which survives restart, resume and
 * provider switches. Never keyed by runtime instance id or directory.
 */
export function sideChatParentFor(
  chat: ChatRecord | null,
  instance: { historyThreadId?: string; workerNodeId?: string } | null,
): SideChatParentRef | null {
  if (chat) {
    return { kind: 'chat', chatId: chat.id };
  }
  if (instance?.historyThreadId) {
    return {
      kind: 'session',
      historyThreadId: instance.historyThreadId,
      originNodeId: instance.workerNodeId ?? null,
    };
  }
  return null;
}

/** The parent's own provider and model, offered as a new sidechat's starting choice. */
export function sideChatParentSelectionFor(
  chat: ChatRecord | null,
  instance: { provider?: string; currentModel?: string; modelRuntimeTarget?: ModelRuntimeTarget } | null,
): SideChatProviderSelection | null {
  if (chat?.provider) {
    return {
      provider: chat.provider,
      model: chat.model,
      reasoning: chat.reasoningEffort,
      modelRuntimeTarget: chat.modelRuntimeTarget ?? null,
    };
  }
  if (instance?.modelRuntimeTarget?.kind === 'local-model') {
    return { provider: 'local-model', model: null, modelRuntimeTarget: instance.modelRuntimeTarget };
  }
  const provider = instance?.provider;
  if (provider && SIDE_CHAT_PROVIDERS.includes(provider as SideChatProvider)) {
    return { provider: provider as SideChatProvider, model: instance?.currentModel ?? null };
  }
  return null;
}
