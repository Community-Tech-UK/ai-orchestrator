import type { Instance } from '../../shared/types/instance.types';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import type { CliResponse } from '../cli/adapters/base-cli-adapter';
import { waitForCompletionUsage } from '../instance/communication-completion-cost';
import { isReceiptCurrent, type CompletionReceipt } from './automation-completion-receipts';

interface WatchedDescendant {
  instance: Instance;
  adapter: CliAdapter;
  detach: () => void;
  receipt?: CompletionReceipt;
  response?: CliResponse;
  charged: boolean;
}
/** A removed child no longer publishes normalized events. Retain its explicit
 * provider settlement, including zero usage, without inventing root authority. */
export class AutomationDescendantSettlement {
  private readonly watched = new Map<string, WatchedDescendant>();
  constructor(private readonly getInstance: (id: string) => Instance | undefined,
    private readonly getAdapter: (id: string) => CliAdapter | undefined,
    private readonly settled: (id: string, usage: CliResponse['usage']) => void) {}
  watch(id: string): void {
    const instance = this.getInstance(id); const adapter = this.getAdapter(id);
    if (!instance || !adapter) return;
    const previous = this.watched.get(id);
    if (previous?.instance === instance && previous.adapter === adapter) return;
    previous?.detach();
    const entry: WatchedDescendant = { instance, adapter, detach: () => adapter.off('complete', complete), charged: false };
    const complete = (response: CliResponse): void => {
      const receipt = { requestCount: instance.requestCount, adapterGeneration: instance.adapterGeneration, restartEpoch: instance.restartEpoch };
      const finalize = () => {
        if (this.watched.get(id) !== entry || !isReceiptCurrent(receipt, instance)) return;
        entry.receipt = receipt; entry.response = response;
        this.observeRemoval(id);
      };
      const pending = waitForCompletionUsage(response);
      if (pending) void pending.then(finalize);
      else finalize();
    };
    this.watched.set(id, entry); adapter.on('complete', complete);
  }
  observeRemoval(id: string): void {
    const entry = this.watched.get(id);
    if (!entry?.receipt || entry.charged || this.getInstance(id) || !isReceiptCurrent(entry.receipt, entry.instance)) return;
    entry.charged = true;
    this.settled(id, entry.response?.usage);
  }
  clear(): void { for (const entry of this.watched.values()) entry.detach(); this.watched.clear(); }
}
