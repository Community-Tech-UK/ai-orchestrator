import { AsyncLocalStorage } from 'node:async_hooks';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import { isKnownSendRefusal } from '../../shared/utils/send-refusal';

/** Never associate receipts by text or position: identical concurrent sends are distinct. */
export function findMessageDeliveryTarget(instance: Pick<Instance, 'outputBuffer' | 'retainedPrompts'>, id?: string): OutputMessage | undefined {
  if (!id) return undefined;
  const matches = (message: OutputMessage) => message.type === 'user' && message.id === id;
  return instance.outputBuffer.find(matches) ?? instance.retainedPrompts?.find(matches);
}

type DeliveryState = 'sending' | 'accepted' | 'uncertain' | 'not-accepted';
const delivery = new AsyncLocalStorage<{ instanceId: string; notify: (state: DeliveryState) => void; claimed: boolean }>();
export function claimMessageDelivery(instanceId: string) {
  const scope = delivery.getStore();
  if (!scope || scope.instanceId !== instanceId || scope.claimed) return undefined;
  scope.claimed = true;
  return scope.notify;
}

/** Scope native admission receipts to the exact user bubble, including concurrent identical sends. */
export async function withMessageDelivery<T>(instanceId: string, timeoutMs: number | null, message: OutputMessage, publish: (message: OutputMessage) => void, send: () => Promise<T>): Promise<T> {
  const receipt: { state: DeliveryState } = { state: 'sending' };
  const update = (next: DeliveryState): void => {
    if (receipt.state === 'accepted' && next !== 'accepted') return;
    receipt.state = next;
    message.metadata = { ...message.metadata, deliveryState: next, deliveryUpdatedAt: Date.now() };
    publish({ ...message, metadata: { ...message.metadata } });
  };
  update('sending');
  const deadline = timeoutMs === null ? undefined : setTimeout(() => update('uncertain'), timeoutMs);
  deadline?.unref?.();
  try {
    const result = await delivery.run({ instanceId, notify: update, claimed: false }, send);
    if (receipt.state === 'sending') update('not-accepted'); // No native delivery receipt; do not infer acceptance from a resolved promise.
    return result;
  } catch (error) {
    if (receipt.state !== 'accepted') update(error instanceof Error && isKnownSendRefusal(error.message) ? 'not-accepted' : 'uncertain');
    throw error;
  } finally {
    if (deadline) clearTimeout(deadline);
  }
}
