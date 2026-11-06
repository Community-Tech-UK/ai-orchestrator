import type { EventEmitter } from 'node:events';
import type { CliResponse, CliUsage } from './base-cli-adapter.types';
import { deferUntilResponseUsageSettled } from './deferred-response-usage';

/** A borrowed request uses the resident pipe, including native defer/resume.
 * The instance owns the process; completing a request never closes that pipe.
 */
export class ClaudeResidentRequest {
  private rejectCurrent: ((error: Error) => void) | undefined;
  constructor(private readonly source: EventEmitter & { getDeferredToolUse(): unknown }) {}
  get pending(): boolean { return this.rejectCurrent !== undefined; }
  cancel(): void { this.rejectCurrent?.(new Error('Claude CLI cancelled')); }

  run(send: () => Promise<void>, afterResponse?: () => Promise<void>): Promise<CliResponse> {
    if (this.pending) return Promise.reject(new Error('Claude resident request already in progress'));
    return new Promise((resolve, reject) => {
      let completed = false;
      let receiptPending = false;
      let completedUsage: CliUsage | undefined;
      const segments: CliUsage[] = [];
      const cleanup = () => {
        this.source.off('complete', onComplete);
        this.source.off('usage', onUsage);
        this.source.off('error', onError);
        this.source.off('exit', onExit);
        this.rejectCurrent = undefined;
      };
      const fail = (error: Error) => {
        if (completed) return;
        if (!('partialUsage' in error) && (completedUsage || segments.length)) {
          Object.assign(error, { partialUsage: completedUsage ?? combineUsage(segments) });
        }
        completed = true;
        cleanup();
        reject(error);
      };
      const onUsage = (usage: CliUsage) => { segments.push(usage); };
      const onComplete = (response: CliResponse) => {
        if (receiptPending || completed) return;
        receiptPending = true;
        const settle = () => {
          if (completed) return;
          const result = { ...response, usage: combineUsage([...segments, response.usage ?? {}]) };
          completedUsage = result.usage;
          void (async () => {
            await afterResponse?.();
            if (completed) return;
            if (response.metadata?.['turnErrored']) {
              fail(Object.assign(new Error(String(response.metadata['claudeResultError'] ?? 'Claude turn failed')),
                { partialUsage: result.usage }));
              return;
            }
            completed = true;
            cleanup();
            resolve(result);
          })().catch(fail);
        };
        if (!deferUntilResponseUsageSettled(response, settle)) settle();
      };
      const onError = (error: Error) => { if (!receiptPending) fail(error); };
      const onExit = () => {
        if (!receiptPending && !this.source.getDeferredToolUse()) fail(new Error('Claude resident process exited before completing the request'));
      };
      this.rejectCurrent = fail;
      this.source.on('complete', onComplete);
      this.source.on('usage', onUsage);
      this.source.on('error', onError);
      this.source.on('exit', onExit);
      void send().catch(error => fail(error instanceof Error ? error : new Error(String(error))));
    });
  }
}

function combineUsage(segments: CliUsage[]): CliUsage {
  const result = { ...segments.at(-1) };
  const keys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens', 'cost'] as const;
  for (const key of keys) {
    const values = segments.map(segment => segment[key]);
    // A missing dollar receipt is unknown, rather than free.
    if (key === 'cost' && values.some(value => value === undefined)) { delete result.cost; continue; }
    if (values.some(value => value !== undefined)) result[key] = values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  }
  return result;
}
