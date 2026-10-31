import { assertGlobalPauseInputCurrent, runWithGlobalPauseInput } from '../global-pause/global-pause-input';
import type { FileAttachment } from '../../shared/types/instance.types';
import { createInstanceInputReceipt } from './instance-adapter-input-dispatch';
import { throwIfInstanceInputAborted, type InstanceSendInputOptions } from './instance-input-cancellation';

/** Local consumption owns a queued admission just as a native provider write does. */
export async function runInstanceLocalInput<T>(
  instanceId: string,
  options: InstanceSendInputOptions | undefined,
  input: { message: string; attachments?: FileAttachment[] },
  action: () => T | Promise<T>,
): Promise<T> {
  if (!options?.queuedAdmissionId) return action();
  return runWithGlobalPauseInput(instanceId, options, async () => {
    throwIfInstanceInputAborted(options.signal);
    assertGlobalPauseInputCurrent(instanceId, options);
    options.assertProviderDispatchCurrent?.();
    const receipt = createInstanceInputReceipt(instanceId, () => input, options.queuedAdmissionId);
    receipt.record();
    try {
      options.beforeProviderDispatch?.();
      throwIfInstanceInputAborted(options.signal);
      const result = await action();
      receipt.delivered();
      return result;
    } catch (error) {
      receipt.failed(error);
      throw error;
    }
  });
}
