/**
 * Records that a loop's adapters were torn down. An invocation takes a watch when it starts; if the loop
 * is cleaned up while the invocation is still awaiting (before its adapter is registered or spawned),
 * the watch reports it so the invocation can stop instead of registering and spawning a child nobody owns.
 */
export function createLoopEndTracker(): {
  watch: (loopRunId: string) => () => boolean;
  end: (loopRunId: string) => void;
} {
  const epochs = new Map<string, number>();
  return {
    watch: (loopRunId) => {
      const started = epochs.get(loopRunId) ?? 0;
      return () => (epochs.get(loopRunId) ?? 0) !== started;
    },
    end: (loopRunId) => { epochs.set(loopRunId, (epochs.get(loopRunId) ?? 0) + 1); },
  };
}
