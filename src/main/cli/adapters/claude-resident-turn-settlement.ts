import type { CliResponse, CliUsage } from './base-cli-adapter.types';
import { deferResponseUsage, deferUntilResponseUsageSettled } from './deferred-response-usage';

/** One failed resident turn, independent of the buffer for later input. */
export class ClaudeResidentTurnSettlement {
  private current: { response: CliResponse; finish: () => void; newerInput: boolean } | null = null;

  constructor(private readonly settleUsage: (response: CliResponse) => void) {}

  get pending(): boolean { return this.current !== null; }

  markInput(): void { if (this.current) this.current.newerInput = true; }

  /** Let a dying native process finish its already-started result frame. */
  async drain(timeoutMs = 250): Promise<void> {
    if (!this.current) return;
    const response = this.current.response;
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, timeoutMs);
      const settled = () => { clearTimeout(timer); resolve(); };
      if (!deferUntilResponseUsageSettled(response, settled)) settled();
    });
  }

  defer(response: CliResponse): void {
    this.settle();
    this.current = { response, finish: deferResponseUsage(response), newerInput: false };
  }

  settle(reported?: CliUsage): boolean {
    const pending = this.current;
    if (!pending) return false;
    this.current = null;
    if (reported) {
      const observed = pending.response.usage;
      pending.response.usage = { ...observed, ...reported };
      // Some error results carry zero final counters despite paid assistant
      // usage. Retain the observed main-thread tokens, and still use the final
      // native aggregate/model snapshots for dollar settlement.
      const tokenFields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'] as const;
      if (reported.totalTokens === 0 && tokenFields.every(key => (reported[key] ?? 0) === 0) && tokenFields.some(key => (observed?.[key] ?? 0) > 0)) {
        for (const key of tokenFields) {
          pending.response.usage[key] = observed?.[key];
        }
      }
    }
    this.settleUsage(pending.response);
    pending.finish();
    return pending.newerInput;
  }
}
