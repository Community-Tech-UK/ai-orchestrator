import { randomUUID } from 'node:crypto';
import type { TurnStartedEvent } from './base-cli-adapter.types';

/**
 * Works out who started each Claude CLI turn, for the adapter's `turn_started` event.
 *
 * Every user message Harness writes carries a `uuid` of its own. The CLI reports each command's life
 * as `command_lifecycle` lines naming that uuid (`queued`, `started`, `completed`), and a turn it
 * starts by itself (after background work ends, a scheduled wake-up) has no such lines. A turn's
 * `init` is therefore Harness's only when the `started` line just before it names a uuid Harness
 * wrote; every other `init` is the provider's. That is an identity match, not a guess from order, so
 * a provider turn that begins between a write and its own turn cannot be taken for it
 * (`src/main/instance/input-turn-registry.ts` relies on this for Plan Queue's "Land anyway").
 */
export class ClaudeTurnStartTracker {
  /** Uuids written whose command has not yet started. */
  private readonly written = new Set<string>();
  /** A command Harness wrote has started and its `init` has not arrived yet. */
  private ownCommandStarted = false;

  /** A message is about to be written: returns the uuid to put on it, remembered until it starts. */
  claimWrite(): string {
    const uuid = randomUUID();
    this.written.add(uuid);
    return uuid;
  }

  /** The write for `uuid` failed, so no command will start from it. */
  releaseWrite(uuid: string): void {
    this.written.delete(uuid);
  }

  /** The CLI reported a `command_lifecycle` line. */
  commandLifecycle(commandUuid: unknown, state: unknown): void {
    if (typeof commandUuid !== 'string') return;
    if (state === 'started') {
      this.ownCommandStarted = this.written.delete(commandUuid);
    } else if (state === 'completed') {
      this.written.delete(commandUuid);
      this.ownCommandStarted = false;
    }
  }

  /** The CLI reported an `init`: a turn started. */
  turnStarted(): TurnStartedEvent {
    const harnessSend = this.ownCommandStarted;
    this.ownCommandStarted = false;
    return { source: harnessSend ? 'harness-send' : 'provider' };
  }

  /** The CLI reported a turn's `result`. */
  turnEnded(): void {
    this.ownCommandStarted = false;
  }

  /** The process exited: nothing written to it will start a turn. */
  reset(): void {
    this.written.clear();
    this.ownCommandStarted = false;
  }
}
