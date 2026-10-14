/**
 * Longest a held message may delay the messages behind it. Identity saves
 * normally take milliseconds, but they share the per-session lock, which a
 * lifecycle operation can hold for much longer. Past this limit later messages
 * publish without waiting, as they did before ordering existed.
 */
export const OUTPUT_ORDER_HOLD_LIMIT_MS = 1_000;

/** One output message's place in its adapter's publication order. */
export interface OutputPublicationTicket {
  /** Settles once every earlier held message has published; undefined when none was held. */
  readonly turn: Promise<void> | undefined;
  /** Call before an await that precedes publication, so later messages queue behind this one. */
  hold(): void;
  /** Call once this message has published, or will not publish. Idempotent. */
  release(): void;
}

/**
 * Keeps one adapter's output messages publishing in emit order.
 *
 * Adapters can emit a whole turn in one synchronous burst (Codex exec sends its
 * tool records and final answer together). The output handler publishes
 * synchronously unless a message must persist session identity first; that
 * message holds the order, and messages emitted meanwhile wait their turn. With
 * nothing held, messages never wait, so the common path keeps its timing.
 */
export class OutputPublicationOrder {
  private tail: Promise<void> | null = null;

  constructor(private readonly holdLimitMs = OUTPUT_ORDER_HOLD_LIMIT_MS) {}

  /** Settles once every currently held message has published; undefined when none is held. */
  pending(): Promise<void> | undefined {
    return this.tail ?? undefined;
  }

  enter(): OutputPublicationTicket {
    let previous: Promise<void> | undefined;
    let released: (() => void) | undefined;
    let limit: ReturnType<typeof setTimeout> | undefined;
    let held = false;
    const release = (): void => {
      if (limit) clearTimeout(limit);
      limit = undefined;
      released?.();
      released = undefined;
    };
    const hold = (): void => {
      if (held) return;
      held = true;
      previous = this.tail ?? undefined;
      const ownRelease = new Promise<void>((resolve) => { released = resolve; });
      const done = previous ? Promise.all([previous, ownRelease]).then(() => undefined) : ownRelease;
      this.tail = done;
      void done.then(() => { if (this.tail === done) this.tail = null; });
      limit = setTimeout(release, this.holdLimitMs);
      limit.unref?.();
    };
    if (this.tail) hold();
    return { turn: previous, hold, release };
  }
}
