import type { EventEmitter } from 'events';

/** Forward presence only, bounded to one frame per watchdog interval. */
export function observeWorkerStderrActivity(adapter: EventEmitter, emit: () => void): () => void {
  let lastSentAt = -Infinity;
  const onStderr = (): void => {
    const now = Date.now();
    if (now - lastSentAt < 10_000) return;
    lastSentAt = now;
    emit();
  };
  adapter.on('stderr', onStderr);
  return () => adapter.off('stderr', onStderr);
}
