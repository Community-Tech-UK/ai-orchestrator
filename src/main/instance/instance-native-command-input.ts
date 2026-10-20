import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import type { ParsedCommand } from '../../shared/types/command.types';
import { generateId } from '../../shared/utils/id-generator';
import { resolveNativeOpenCodeCommand } from '../commands/provider-native-commands';
import type { InstanceSendInputOptions } from './instance-input-cancellation';

/** Native commands keep ordinary admission, but cannot enter Harness template/context expansion. */
export async function dispatchNativeOpenCodeCommand(context: {
  instance: Instance; command: ParsedCommand; originalInput: string; options?: InstanceSendInputOptions;
  deferredCommit: boolean; getAdapter: () => unknown; recordPromptHistory: () => void;
  emitUser: (message: OutputMessage) => void;
  send: (prompt: string, options: InstanceSendInputOptions) => Promise<void>;
}): Promise<void> {
  const { instance, command, options } = context;
  const validate = () => {
    if (!resolveNativeOpenCodeCommand(instance.provider, context.getAdapter(), command.command.id, command.args)) {
      throw new Error('The selected native command is no longer available in this session.');
    }
  };
  const userMessage: OutputMessage = { id: generateId(), timestamp: Date.now(), type: 'user', content: context.originalInput,
    metadata: { command: { name: command.command.name, resolved: true, executionType: command.execution.type,
      providerNativeCommandId: command.command.id } } };
  if (!options?.isRetry && !context.deferredCommit) context.emitUser(userMessage);
  await context.send(command.resolvedPrompt, { ...options, providerNativeCommandId: command.command.id,
    beforeProviderDispatch: () => {
      validate(); options?.beforeProviderDispatch?.();
      if (context.deferredCommit) { context.recordPromptHistory(); instance.requestCount++; context.emitUser(userMessage); }
    },
    assertProviderDispatchCurrent: (reason) => { validate(); options?.assertProviderDispatchCurrent?.(reason); },
  });
}
