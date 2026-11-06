import { isVersionAtLeast } from './claude-cli-feature-probes';
import { asUnknownRecord, type RawCliPayload } from './claude-cli-adapter.types';

// First version with retained same-session, manual-boundary and recall evidence.
export const CLAUDE_NATIVE_COMPACT_MIN_VERSION = '2.1.310';
export const CLAUDE_NATIVE_COMPACT_FOCUS = 'Keep my open requests word for word, the decisions made and why, exact file paths, commands and error messages, and what is left to do.';

interface ClaudeNativeCompactionHost {
  isResident(): boolean;
  isTurnActive(): boolean;
  cliVersion(): string | null | undefined;
  writeRaw(line: string): Promise<void>;
  onCompactionObserved(callback: () => void): () => void;
}

interface CompactAttempt {
  resolve(result: boolean): void;
  finish(result: boolean): void;
  finished: Promise<boolean>;
  unsubscribe(): void;
  timer: ReturnType<typeof setTimeout>;
  observed: boolean;
}

/** A raw /compact turn, confirmed by provider evidence rather than an assistant claim. */
export class ClaudeNativeCompaction {
  private attempt: CompactAttempt | null = null;
  private unsupported = false;

  constructor(private readonly host: ClaudeNativeCompactionHost) {}

  supported(): boolean {
    return this.host.isResident() && isVersionAtLeast(this.host.cliVersion(), CLAUDE_NATIVE_COMPACT_MIN_VERSION);
  }

  knownUnsupported(): boolean { return this.unsupported; }
  isCompacting(): boolean { return this.attempt !== null; }

  /** New input waits for the terminal receipt, not just the earlier boundary. */
  async waitForCompletion(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const attempt = this.attempt;
    if (!attempt) return;
    const finished = signal ? new Promise<boolean>((resolve, reject) => {
      const onAbort = (): void => {
        signal.removeEventListener('abort', onAbort);
        reject(signal.reason);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      void attempt.finished.then(result => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      });
      if (signal.aborted) onAbort();
    }) : attempt.finished;
    if (!await finished) throw new Error('Claude compaction did not finish. The message was not sent; retry after recovery.');
    signal?.throwIfAborted();
  }

  compact(focus = CLAUDE_NATIVE_COMPACT_FOCUS): Promise<boolean> {
    if (this.attempt || this.unsupported || !this.supported() || this.host.isTurnActive()) return Promise.resolve(false);
    return new Promise(resolve => {
      let finish!: (result: boolean) => void;
      const finished = new Promise<boolean>(done => { finish = done; });
      const attempt: CompactAttempt = {
        resolve, finish, finished, observed: false, unsubscribe: () => undefined,
        timer: setTimeout(() => this.finish(attempt, false), 300_000),
      };
      this.attempt = attempt;
      attempt.unsubscribe = this.host.onCompactionObserved(() => {
        if (this.attempt !== attempt) return;
        attempt.observed = true;
        resolve(true);
        // Keep ownership through result: the CLI still owes its summary echoes and cost receipt.
      });
      try {
        void this.host.writeRaw(JSON.stringify({
          type: 'user', message: { role: 'user', content: `/compact ${focus}` },
        })).catch(() => this.finish(attempt, false));
      } catch { this.finish(attempt, false); }
    });
  }

  observeMessage(message: RawCliPayload): void {
    const attempt = this.attempt;
    if (!attempt) return;
    if (message.type === 'result') this.finish(attempt,
      attempt.observed && message.is_error !== true && !message.subtype?.startsWith('error'));
    else if (message.type === 'error' || message.isApiErrorMessage) this.finish(attempt, false);
    else if (!attempt.observed && message.type === 'assistant' && !message.parent_tool_use_id
      && (message.content?.trim() || message.message?.content?.some(block => block.type === 'text' && block.text?.trim()))) {
      this.unsupported = true;
      this.finish(attempt, false);
    }
  }

  isCompactionEcho(message: unknown): boolean {
    const raw = asUnknownRecord(message);
    return this.attempt !== null && raw?.['type'] === 'user'
      && (raw['isSynthetic'] === true || raw['isReplay'] === true || raw['isCompactSummary'] === true);
  }

  cancel(): void { if (this.attempt) this.finish(this.attempt, false); }

  private finish(attempt: CompactAttempt, result: boolean): void {
    if (this.attempt !== attempt) return;
    this.attempt = null;
    clearTimeout(attempt.timer);
    attempt.unsubscribe();
    attempt.resolve(result);
    attempt.finish(result);
  }
}
