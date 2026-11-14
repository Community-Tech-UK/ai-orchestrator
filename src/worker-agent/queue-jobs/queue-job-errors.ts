import type { QueueRefusalReason } from '../../main/remote-node/queue-job-rpc-schemas';

/** A call this computer refuses on purpose, with a reason this Mac shows in plain words. */
export class QueueJobRefusal extends Error {
  constructor(readonly reason: QueueRefusalReason, message: string) {
    super(message);
    this.name = 'QueueJobRefusal';
  }
}
