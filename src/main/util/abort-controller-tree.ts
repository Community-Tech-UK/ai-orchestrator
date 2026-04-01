/**
 * Hierarchical AbortController tree with GC-safe parent-child propagation.
 *
 * Pattern from Claude Code utils/abortController.ts:
 * - Parent abort cascades to all children
 * - Child abort does NOT cascade to parent or siblings
 * - Cleanup listeners removed when child aborts independently
 * - setMaxListeners(50) prevents Node.js warnings
 */

import { setMaxListeners } from 'events';

/**
 * Create a root AbortController with raised listener limit.
 */
export function createAbortController(): AbortController {
  const ac = new AbortController();
  try {
    setMaxListeners(50, ac.signal);
  } catch {
    // Older Node.js versions may not support setMaxListeners on AbortSignal
  }
  return ac;
}

/**
 * Create a child AbortController that aborts when parent aborts.
 * Child abort is independent -- does not affect parent or siblings.
 * Listener is cleaned up when the child aborts to prevent leaks.
 */
export function createChildAbortController(parent: AbortController): AbortController {
  const child = createAbortController();

  // If parent is already aborted, abort child immediately
  if (parent.signal.aborted) {
    child.abort(parent.signal.reason);
    return child;
  }

  // Propagate parent abort to child
  const onParentAbort = () => {
    child.abort(parent.signal.reason);
  };

  parent.signal.addEventListener('abort', onParentAbort, { once: true });

  // When child aborts independently, remove the parent listener
  child.signal.addEventListener('abort', () => {
    parent.signal.removeEventListener('abort', onParentAbort);
  }, { once: true });

  return child;
}
