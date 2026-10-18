import type { CliResponse } from "./base-cli-adapter.types";
import type { EventEmitter } from "node:events";
import { markProviderDispatchNotStarted } from "./provider-dispatch-status";

/** Subscribe before signalling; start the close deadline only after teardown. */
export function watchClaudeProcessClose(
  source: EventEmitter,
): () => Promise<void> {
  let closed = false;
  let finish!: () => void;
  const complete = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const onClose = () => {
    closed = true;
    finish();
  };
  source.once("close", onClose);
  return () => {
    if (closed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const settle = () => {
        source.off("close", onClose);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(settle, 3000);
      void complete.then(settle);
    });
  };
}

/** Raw evidence outlives BaseCliAdapter's transport buffer during shutdown. */
export class ClaudeOneShotTurn {
  raw = "";
  error: Error | undefined;
  cancelled = false;
  started = false;
  dispatched = false;
  finished = false;
  forceClose: ((error: Error) => void) | undefined;
  private resultSeen = false;
  private resolveFinished!: () => void;
  private resolveResult!: () => void;
  private readonly closed = new Promise<void>((resolve) => {
    this.resolveFinished = resolve;
  });
  private readonly result = new Promise<void>((resolve) => {
    this.resolveResult = resolve;
  });
  private readonly onError = (error: Error) => {
    this.error ??= error;
  };

  constructor(private readonly source: EventEmitter) {
    source.on("error", this.onError);
  }

  failure(response: CliResponse): Error | undefined {
    if (this.error) return this.error;
    if (this.cancelled) return new Error("Claude CLI cancelled");
    if (response.metadata?.["turnErrored"] === true) {
      return new Error(
        String(
          response.metadata["claudeResultError"] ??
            "Claude CLI reported an error result",
        ),
      );
    }
    return undefined;
  }

  beforeStartFailure(error: unknown): Error {
    const failure = error instanceof Error ? error : new Error(String(error));
    return this.started ? failure : markProviderDispatchNotStarted(failure);
  }

  failInput(error: unknown, terminate: () => Promise<void>): void {
    if (this.finished) return;
    const failure = error instanceof Error ? error : new Error(String(error));
    this.error ??=
      this.started && this.dispatched
        ? failure
        : markProviderDispatchNotStarted(failure);
    // Formatting can fail after spawn, and a failed write ACK can follow billing.
    // Both retain this turn's raw evidence through the owned close boundary.
    void terminate().catch(() => this.forceClose?.(this.error ?? failure));
  }

  noteResult(): void {
    this.resultSeen = true;
    this.resolveResult();
  }
  cancel(): void {
    if (!this.finished) this.cancelled = true;
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.source.off("error", this.onError);
    this.resolveFinished();
    this.resolveResult();
  }

  async drain(): Promise<void> {
    if (this.started && this.error && !this.resultSeen && !this.finished)
      await this.wait(this.result, 250);
  }

  async waitForClose(): Promise<void> {
    if (!this.started || this.finished) return;
    await this.wait(this.closed, 3000, () => {
      this.forceClose?.(
        this.error ?? new Error("Claude CLI cancelled during process closure"),
      );
    });
  }

  private wait(
    signal: Promise<void>,
    timeoutMs: number,
    onTimeout?: () => void,
  ): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        onTimeout?.();
        resolve();
      }, timeoutMs);
      void signal.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

/** Fence async preparation, and serialize teardown without forbidding reuse. */
export class ClaudeOneShotLifecycle {
  current: ClaudeOneShotTurn | undefined;
  private epoch = 0;
  private stopping: Promise<void> | undefined;

  prepare(): number {
    this.admit(this.epoch);
    return this.epoch;
  }

  admit(epoch: number): void {
    if (this.stopping || epoch !== this.epoch) {
      throw markProviderDispatchNotStarted(
        new Error("Claude CLI cancelled before provider dispatch"),
      );
    }
  }

  terminate(operation: () => Promise<void>, cancelCurrent = true): Promise<void> {
    if (this.stopping) return this.stopping;
    ++this.epoch;
    if (cancelCurrent) this.current?.cancel();
    const pending = operation();
    this.stopping = pending;
    const clear = () => {
      if (this.stopping === pending) this.stopping = undefined;
    };
    void pending.then(clear, clear);
    return pending;
  }

  finish(turn: ClaudeOneShotTurn): void {
    turn.finish();
    if (this.current === turn) this.current = undefined;
  }
}
