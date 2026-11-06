import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import { getOutputStorageManager } from '../memory/output-storage';
import { retainedPromptsMissingFrom } from '../instance/prompt-retention';
import { getToolOutcomes } from '../learning/tool-outcome-store';

/**
 * The live buffer is bounded, so its older messages may already be in
 * output storage. Flush pending asynchronous writes and join that prefix to
 * the retained tail before creating permanent history.
 *
 * The instance's retained prompts are folded in as well. They are normally
 * already in output storage, but not when disk storage is disabled or its
 * write failed — and an archive that lost the user's own prompts is the
 * exact failure this path exists to prevent.
 */
export async function getCompleteInstanceMessages(instance: Instance): Promise<OutputMessage[]> {
  const retainedMessages = [...instance.outputBuffer];
  const outputStorage = getOutputStorageManager();
  await outputStorage.flushInstance(instance.id);
  const storedMessages = await outputStorage.loadMessages(instance.id);

  // Ids are trustworthy between disk and the live buffer — both hold the
  // original message objects. They are NOT trustworthy for retained prompts:
  // a hibernate/wake round trip renumbers persisted entries positionally and
  // wake re-derives the prompt's id from that, so the same prompt can reach
  // here under a different id than its on-disk copy and would archive twice.
  const persisted = [...storedMessages, ...retainedMessages];
  const messagesById = new Map<string, OutputMessage>();
  for (const message of [
    ...storedMessages,
    ...retainedPromptsMissingFrom(instance.retainedPrompts, persisted),
    ...retainedMessages,
    // LT-196: held out of `outputBuffer`; folded in only here — see
    // `tool-outcome-store.ts`.
    ...getToolOutcomes(instance.id),
  ]) {
    messagesById.set(message.id, message);
  }

  // The three sources overlap, so none of them is a clean chronological
  // prefix of the others. Sort is stable, so equal timestamps keep source
  // order.
  return Array.from(messagesById.values()).sort((a, b) => a.timestamp - b.timestamp);
}
