/**
 * Walk a transcript back through its older history: first the loaded items
 * the render window hides, then pages from disk storage, until the caller's
 * condition holds or nothing older remains.
 *
 * Drives "Scroll to top" (reveal everything, then land on the session's first
 * message) and jump-rail clicks on prompts outside the rendered window (reveal
 * until that prompt renders). Both used to depend on repeated scroll-edge
 * loads or a capped number of rail requests, which ran out long before the
 * start of a big session.
 */

export type RevealOutcome = 'done' | 'exhausted' | 'stalled' | 'stale';

export interface RevealOlderHistoryOptions {
  /** True once enough history is rendered — checked before every step. */
  done: () => boolean;
  /** True when the transcript switched sessions; the walk stops. */
  isStale: () => boolean;
  /** Loaded display items the render window currently hides. */
  hiddenRenderedCount: () => number;
  /** Render every loaded item the window hides. */
  revealAllRendered: () => void;
  /** Whether disk storage (or a custom loader) has older messages to give. */
  hasOlderMessages: () => boolean;
  /** Load the next older page; resolves when it has been applied. */
  loadOlderMessages: () => Promise<void>;
  /**
   * Snapshot of everything a step can change (message count, page cursor,
   * hidden count, has-more flag). A step that leaves it unchanged failed, so
   * the walk stops instead of spinning.
   */
  progressKey: () => string;
  /** Wait for the step to render, so inputs and DOM reflect it. */
  afterStep: () => Promise<void>;
}

export async function revealOlderHistory(options: RevealOlderHistoryOptions): Promise<RevealOutcome> {
  for (;;) {
    if (options.isStale()) return 'stale';
    if (options.done()) return 'done';

    const before = options.progressKey();
    if (options.hiddenRenderedCount() > 0) {
      options.revealAllRendered();
    } else if (options.hasOlderMessages()) {
      await options.loadOlderMessages();
    } else {
      return 'exhausted';
    }
    await options.afterStep();

    if (options.progressKey() === before) return options.isStale() ? 'stale' : 'stalled';
  }
}
