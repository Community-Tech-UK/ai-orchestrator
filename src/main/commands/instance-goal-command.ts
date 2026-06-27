import type {
  FileAttachment,
  Instance,
  OutputMessage,
} from '../../shared/types/instance.types';
import { applyGoalCommand } from './goal-command';

interface HandleInstanceGoalCommandInput {
  instance: Instance;
  args: readonly string[];
  attachments?: FileAttachment[];
  userMessage: OutputMessage;
  recordUserMessage: (message: OutputMessage) => void;
  emitSystemMessage: (content: string, metadata?: Record<string, unknown>) => void;
  sendProviderPrompt: (
    prompt: string,
    attachments: FileAttachment[] | undefined,
    options: { autoContinuation: boolean },
  ) => Promise<void>;
  autoContinuation: boolean;
}

export async function handleInstanceGoalCommand({
  instance,
  args,
  attachments,
  userMessage,
  recordUserMessage,
  emitSystemMessage,
  sendProviderPrompt,
  autoContinuation,
}: HandleInstanceGoalCommandInput): Promise<void> {
  recordUserMessage(userMessage);

  if (instance.provider !== 'claude' && instance.provider !== 'codex') {
    emitSystemMessage('Goal mode is available for Claude and Codex sessions.', {
      source: 'goal-command',
      action: 'unsupported-provider',
      provider: instance.provider,
    });
    return;
  }

  const result = applyGoalCommand(instance, args);
  emitSystemMessage(result.notice, {
    source: 'goal-command',
    action: result.action,
    status: result.state?.status ?? 'none',
  });

  if (result.providerPrompt) {
    await sendProviderPrompt(result.providerPrompt, attachments, { autoContinuation });
  }
}
