import type { FileAttachment, Instance, InstanceCreateConfig } from '../../../shared/types/instance.types';
import type { CliAdapter } from '../../cli/adapters/adapter-factory';
import { BaseCliAdapter } from '../../cli/adapters/base-cli-adapter';
import { RemoteCliAdapter } from '../../cli/adapters/remote-cli-adapter';
import { GlobalPauseService } from '../../global-pause/global-pause-service';
import { assertAutomaticStartupCurrent, markAutomaticStartupInputDispatched } from '../../work-admission/automatic-startup';

const initialPromptIntent = new WeakMap<Instance, boolean>();
export function recordInitialPromptIntent(instance: Instance, config: InstanceCreateConfig): void {
  initialPromptIntent.set(instance, Boolean(config.initialPrompt?.trim() || config.attachments?.length));
}
export function hasConfiguredInitialPrompt(instance: Instance): boolean | undefined { return initialPromptIntent.get(instance); }

class InitialPromptHeldError extends Error {}
export function isInitialPromptHeld(error: unknown): boolean { return error instanceof InitialPromptHeldError; }

/** A create-time first turn remains owned through the adapter's asynchronous preparation. */
export async function sendInitialPromptToAdapter(instance: Instance, adapter: CliAdapter, message: string, attachments?: FileAttachment[]): Promise<void> {
  const signal = instance.abortController?.signal;
  const beforeProviderDispatch = (): void => {
    signal?.throwIfAborted();
    assertAutomaticStartupCurrent();
    if (GlobalPauseService.peek()?.holdsAutomaticInput(instance.id)) throw new InitialPromptHeldError();
    markAutomaticStartupInputDispatched(instance.id);
  };
  if (adapter instanceof BaseCliAdapter || adapter instanceof RemoteCliAdapter) {
    await adapter.sendInput(message, attachments, { dispatch: { signal, beforeProviderDispatch } });
  } else {
    beforeProviderDispatch();
    await adapter.sendInput(message, attachments);
  }
}
