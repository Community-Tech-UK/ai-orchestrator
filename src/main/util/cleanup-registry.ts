/**
 * Cleanup Registry -- services register their own cleanup at construction time.
 *
 * Pattern from Claude Code utils/cleanupRegistry.ts:
 * - registerCleanup(fn) returns an unregister function
 * - runCleanupFunctions() runs all concurrently with a timeout
 * - Replaces fragile manual teardown lists in terminateInstance() and shutdown()
 */

type CleanupFn = () => void | Promise<void>;

const cleanups = new Set<CleanupFn>();

/**
 * Register a cleanup function to run on shutdown.
 * Returns an unregister function -- call it on normal completion.
 */
export function registerCleanup(fn: CleanupFn): () => void {
  cleanups.add(fn);
  let removed = false;
  return () => {
    if (!removed) {
      cleanups.delete(fn);
      removed = true;
    }
  };
}

/**
 * Run all registered cleanup functions concurrently.
 * Each cleanup is wrapped in try/catch -- one failure does not block others.
 * Clears the registry after running.
 *
 * @param timeoutMs Maximum time to wait for all cleanups (default: 2000ms)
 */
export async function runCleanupFunctions(timeoutMs = 2000): Promise<void> {
  const fns = [...cleanups];
  cleanups.clear();

  if (fns.length === 0) return;

  const results = fns.map(async (fn) => {
    try {
      await fn();
    } catch {
      // Swallow -- cleanup failures must not block shutdown
    }
  });

  await Promise.race([
    Promise.allSettled(results),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

/** Number of registered cleanup functions. */
export function getCleanupCount(): number {
  return cleanups.size;
}

/** Reset for testing -- clears all registered cleanups. */
export function _resetForTesting(): void {
  cleanups.clear();
}
